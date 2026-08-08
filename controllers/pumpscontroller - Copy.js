const db = require('../models/db');

function isAdminRole(roleValue) {
  const normalizedRole = String(roleValue || '').trim().toLowerCase();
  return normalizedRole.includes('admin') || normalizedRole === '1' || Number(normalizedRole) === 1;
}

function getConnection() {
  return db.getConnection();
}

async function upsertMobileOilPurchaseRows(connection, { pumpId, stockItems, actorName }) {
  const rows = Array.isArray(stockItems) ? stockItems : [];
  const normalizedRows = rows
    .map((row) => {
      const containerType = String(row?.container_type || '').trim().toLowerCase();
      const normalizedContainerType = ['carton', 'can', 'drum', 'dew'].includes(containerType)
        ? containerType
        : null;
      const containerLiters = row?.container_liters != null ? Number(row.container_liters) : null;
      const count = row?.count != null ? Number(row.count) : null;
      const totalLiters = Number(row?.total_liters || 0);
      const ratePerLiter = row?.rate_per_liter != null ? Number(row.rate_per_liter) : null;
      const totalAmount = row?.total_amount != null ? Number(row.total_amount) : null;

      return {
        container_type: normalizedContainerType,
        container_liters: Number.isFinite(containerLiters) ? containerLiters : null,
        no_of_containers: Number.isFinite(count) ? count : null,
        liters_purchased: Number.isFinite(totalLiters) ? totalLiters : 0,
        rate_per_liter: Number.isFinite(ratePerLiter) ? ratePerLiter : null,
        total_amount: Number.isFinite(totalAmount) ? totalAmount : null
      };
    })
    .filter((row) => row.container_type && row.liters_purchased > 0);

  if (normalizedRows.length === 0) {
    return;
  }

  // Fetch latest mobile oil rate if not provided in stock item
  let defaultRate = 0;
  try {
    const [rateRows] = await connection.execute(
      `SELECT rate_per_liter FROM fuel_rates 
       WHERE fuel_type_id = 3 AND (Active = 1 OR Active IS NULL)
       ORDER BY effective_date DESC LIMIT 1`
    );
    if (rateRows && rateRows.length > 0) {
      defaultRate = Number(rateRows[0].rate_per_liter || 0);
    }
  } catch (err) {
    console.warn('Could not fetch mobile oil rate from fuel_rates:', err.message);
  }

  const [columnRows] = await connection.execute(`SHOW COLUMNS FROM mobile_oil_purchase`);
  const availableColumns = new Set((columnRows || []).map((c) => String(c.Field || '').toLowerCase()));

  // For updates, deactivate previous rows when table supports pump linkage.
  if (availableColumns.has('pump_id')) {
    await connection.execute(
      `UPDATE mobile_oil_purchase SET active = 0, md = NOW(), mb = ? WHERE pump_id = ? AND (active = 1 OR active IS NULL)`,
      [actorName, pumpId]
    );
  }

  for (const row of normalizedRows) {
    const columns = [];
    const values = [];
    const placeholders = [];

    const maybeAdd = (column, value) => {
      if (availableColumns.has(column)) {
        columns.push(column);
        values.push(value);
        placeholders.push('?');
      }
    };

    // Use rate from stock item, or default to latest from fuel_rates
    const finalRate = row.rate_per_liter != null ? row.rate_per_liter : defaultRate;
    const finalTotal = row.total_amount != null ? row.total_amount : (row.liters_purchased * finalRate);

    maybeAdd('pump_id', pumpId);
    maybeAdd('liters_purchased', row.liters_purchased);
    maybeAdd('rate_per_liter', finalRate);
    maybeAdd('total_amount', finalTotal);
    maybeAdd('container_type', row.container_type);
    maybeAdd('container_liters', row.container_liters);
    maybeAdd('no_of_containers', row.no_of_containers);
    maybeAdd('cb', actorName);
    maybeAdd('mb', actorName);

    if (availableColumns.has('active')) {
      columns.push('active');
      placeholders.push('1');
    }
    if (availableColumns.has('cd')) {
      columns.push('cd');
      placeholders.push('NOW()');
    }
    if (availableColumns.has('md')) {
      columns.push('md');
      placeholders.push('NOW()');
    }

    if (columns.length === 0) {
      continue;
    }

    await connection.execute(
      `INSERT INTO mobile_oil_purchase (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );
  }
}

exports.getTankTypes = async (req, res) => {
  try {
    let rows = [];
    let connection;
    try {
      connection = await db.getConnection();
      const [resultRows] = await connection.execute(
        `SELECT id, total_capacity_liters, max_dip_mm
         FROM tank_types
         WHERE Active = 1
         ORDER BY total_capacity_liters`
      );
      rows = resultRows || [];
    } catch (queryErr) {
      if (queryErr.code !== 'ER_BAD_FIELD_ERROR') {
        throw queryErr;
      }

      const [fallbackRows] = await getConnection().execute(
        `SELECT id, fuel_type, total_capacity_liters, max_dip_mm
         FROM tank_types
         ORDER BY total_capacity_liters`
      );
      rows = fallbackRows || [];
    } finally {
      if (connection) connection.release();
    }

    res.json(rows.map((row) => ({
      id: Number(row.id),
      fuel_type: row.fuel_type || '',
      total_capacity_liters: Number(row.total_capacity_liters) || 0,
      max_dip_mm: Number(row.max_dip_mm) || 0
    })));
  } catch (err) {
    console.error('Error fetching tank types:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json([]);
    }
    res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

exports.getMobileOilRate = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    // Get latest fuel rate for Mobile Oil (fuel_type_id = 3) with Active = 1
    const [rateRows] = await connection.execute(
      `SELECT rate_per_liter, effective_date 
       FROM fuel_rates 
       WHERE fuel_type_id = 3 AND (Active = 1 OR Active IS NULL)
       ORDER BY effective_date DESC 
       LIMIT 1`
    );

    if (rateRows && rateRows.length > 0) {
      const rate = rateRows[0];
      return res.json({
        rate_per_liter: Number(rate.rate_per_liter || 0),
        effective_date: rate.effective_date || new Date().toISOString().split('T')[0]
      });
    }

    // Default to 0 if no rate found
    res.json({
      rate_per_liter: 0,
      effective_date: new Date().toISOString().split('T')[0]
    });
  } catch (err) {
    console.error('Error fetching mobile oil rate:', err);
    res.status(500).json({
      rate_per_liter: 0,
      effective_date: new Date().toISOString().split('T')[0]
    });
  } finally {
    if (connection) connection.release();
  }
};

exports.getMobileOilStockItems = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const { pump_id } = req.query;
    if (!pump_id) {
      return res.json([]);
    }

    // Get active mobile oil purchase records for the pump
    const [rows] = await connection.execute(
      `SELECT 
        id,
        pump_id,
        liters_purchased,
        rate_per_liter,
        total_amount,
        container_type,
        container_liters,
        no_of_containers,
        active,
        cd,
        md,
        cb,
        mb
       FROM mobile_oil_purchase
       WHERE pump_id = ? AND (active = 1 OR active IS NULL)
       ORDER BY cd DESC`,
      [pump_id]
    );

    const stockItems = (rows || []).map((row) => ({
      id: Number(row.id),
      pump_id: Number(row.pump_id),
      liters_purchased: Number(row.liters_purchased || 0),
      rate_per_liter: Number(row.rate_per_liter || 0),
      total_amount: Number(row.total_amount || 0),
      container_type: String(row.container_type || '').toLowerCase(),
      container_liters: Number(row.container_liters || 0),
      no_of_containers: Number(row.no_of_containers || 0),
      active: Number(row.active || 1),
      cd: row.cd,
      md: row.md,
      cb: row.cb,
      mb: row.mb
    }));

    res.json(stockItems);
  } catch (err) {
    console.error('Error fetching mobile oil stock items:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json([]);
    }
    res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

/* exports.saveAdjustmentValues = async (req, res) => {
  try {
    const { pump_id, adjustments } = req.body;

    if (!pump_id || !Array.isArray(adjustments) || adjustments.length === 0) {
      return res.status(400).json({ message: 'pump_id and adjustments array are required' });
    }

    let connection;
    connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      let updatedCount = 0;
      for (const adj of adjustments) {
        const { tank_id, adjustment_value, variance } = adj;
        if (!tank_id || adjustment_value === null || adjustment_value === undefined) {
          continue;
        }

        const adjustmentNum = Number(adjustment_value);
        const varianceNum = variance === null || variance === undefined ? adjustmentNum : Number(variance);

        // Apply the same signed adjustment to the tank's current stock level.
        await connection.execute(
          `UPDATE fuel_tanks
             SET current_level = COALESCE(current_level, 0) + ?, MB = NOW(), MD = NOW()
             WHERE id = ?`,
          [adjustmentNum, tank_id]
        );
        updatedCount++;
        // Find the most recent physical dip reading for this tank
        const [[latestDip]] = await connection.execute(
          `SELECT id FROM physical_dip_readings 
           WHERE tank_id = ? AND Active = 1 
           ORDER BY reading_time DESC, id DESC LIMIT 1`,
          [tank_id]
        );

        if (latestDip) {
          // Update the adjustment_value on the existing record
          await connection.execute(
            `UPDATE physical_dip_readings 
             SET adjustment_value = ?, MB = NOW(), MD = NOW()
             WHERE id = ?`,
            [adjustmentNum, latestDip.id]
          );


        }
      }

      await connection.commit();

      res.json({
        success: true,
        message: `${updatedCount} adjustment(s) saved successfully`,
        updated_count: updatedCount
      });
    } finally {
      if (connection) connection.release();
    }
  } catch (err) {
    console.error('Error saving adjustment values:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
}; */


exports.saveAdjustmentValues = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const { pump_id, adjustments } = req.body;


    if (!pump_id || !Array.isArray(adjustments) || adjustments.length === 0) {
      return res.status(400).json({ message: 'pump_id and adjustments array are required' });
    }

    // Get the current user (adjuster) – adjust based on your auth system
    const currentUser = req.user?.username || req.user?.id || 'system';



    try {
      await connection.beginTransaction();

      let updatedCount = 0;
      for (const adj of adjustments) {
        const { tank_id, adjustment_value, variance, cb, mb } = adj;
        const createdBy = cb || 'system';
        const modifiedBy = mb || createdBy;
        if (!tank_id || adjustment_value === null || adjustment_value === undefined) {
          continue;
        }

        const adjustmentNum = Number(adjustment_value);
        const varianceNum = variance === null || variance === undefined ? adjustmentNum : Number(variance);

        // 1. Update tank's current level
        await connection.execute(
          `UPDATE fuel_tanks
             SET current_level = COALESCE(current_level, 0) + ?, MB = NOW(), MD = NOW()
             WHERE id = ?`,
          [adjustmentNum, tank_id]
        );

        // 2. Insert into fuel_tank_adjustments
        await connection.execute(
          `INSERT INTO fuel_tank_adjustments
             (tank_id, adjustment_value, CB, MB, CD, MD, Active, Entry_Date)
           VALUES (?, ?, ?, ?, NOW(), NOW(), 1, CURDATE())`,
          [tank_id, adjustmentNum, createdBy, modifiedBy]   // MB same as CB, or set NULL
        );

        // 3. Find the most recent physical dip reading for this tank
        const [[latestDip]] = await connection.execute(
          `SELECT id FROM physical_dip_readings 
           WHERE tank_id = ? AND Active = 1 
           ORDER BY reading_time DESC, id DESC LIMIT 1`,
          [tank_id]
        );

        if (latestDip) {
          // 4. Update adjustment_value on that dip reading
          await connection.execute(
            `UPDATE physical_dip_readings 
             SET adjustment_value = ?, MB = NOW(), MD = NOW()
             WHERE id = ?`,
            [adjustmentNum, latestDip.id]
          );
        }

        updatedCount++;
      }

      await connection.commit();

      res.json({
        success: true,
        message: `${updatedCount} adjustment(s) saved successfully`,
        updated_count: updatedCount
      });
    } finally {
      if (connection) connection.release();
    }
  } catch (err) {
    console.error('Error saving adjustment values:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

exports.getPumps = async (req, res) => {
  let connection;
  try {

    connection = await db.getConnection();
    const query = `
      SELECT 
        pp.id,
        pp.name,
        pp.location,
        pp.manager_id,
        m.name AS manager_name,
        pp.Active,
        pp.CB,
        pp.CD,
        pp.MB,
        pp.MD,
        (
          SELECT COUNT(*) 
          FROM fuel_tanks ft 
          WHERE ft.pump_id = pp.id AND ft.Active = 1
        ) AS tank_count,
        (
          SELECT COUNT(*) 
          FROM machines mc 
          WHERE mc.pump_id = pp.id AND mc.Active = 1
        ) AS machine_count,
        (
          SELECT COUNT(*) 
          FROM nozzles nz
          JOIN machines mc2 ON nz.machine_id = mc2.id
          WHERE mc2.pump_id = pp.id AND nz.Active = 1
        ) AS nozzle_count
      FROM petrol_pumps pp
      LEFT JOIN users m ON pp.manager_id = m.id
      WHERE pp.Active = 1
      ORDER BY pp.name;
    `;

    const [rows] = await connection.execute(query);
    const pumpIds = (rows || []).map((r) => r.id).filter(Boolean);
    let inventoryByPump = {};
    if (pumpIds.length > 0) {
      const placeholders = pumpIds.map(() => '?').join(',');
      const [tankRows] = await db.execute(
        `SELECT pump_id, fuel_type,
          SUM(current_level) AS current_level,
          SUM(capacity) AS capacity
         FROM fuel_tanks
         WHERE pump_id IN (${placeholders}) AND Active = 1
         GROUP BY pump_id, fuel_type`,
        pumpIds
      );
      (tankRows || []).forEach((t) => {
        if (!inventoryByPump[t.pump_id]) inventoryByPump[t.pump_id] = [];
        inventoryByPump[t.pump_id].push({
          fuel_type: t.fuel_type,
          current_level: Number(t.current_level) || 0,
          capacity: Number(t.capacity) || 0
        });
      });
    }
    const result = (rows || []).map((p) => ({
      ...p,
      inventory: inventoryByPump[p.id] || []
    }));
    res.json(result);
  } catch (err) {
    console.error('Error fetching pumps:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json([]);
    }
    res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

exports.getPumpDetails = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ message: 'Pump ID is required' });
    }

    const [[pumpRows], [tankRows], [machineRows], [nozzleRows], [staffRows]] = await Promise.all([
      connection.execute(
        `SELECT 
           pp.*,
           m.name AS manager_name,
           m.email AS manager_email
         FROM petrol_pumps pp
         LEFT JOIN users m ON pp.manager_id = m.id
         WHERE pp.id = ?`,
        [id]
      ),
      connection.execute(
        `SELECT 
           ft.*, 
           tt.total_capacity_liters
         FROM fuel_tanks ft
         LEFT JOIN tank_types tt ON ft.tank_type_id = tt.id
         WHERE pump_id = ? 
         ORDER BY fuel_type, tank_number`,
        [id]
      ),
      connection.execute(
        `SELECT * 
         FROM machines 
         WHERE pump_id = ? 
         ORDER BY machine_number`,
        [id]
      ),
      connection.execute(
        `SELECT nz.*,
                ft.tank_number,
                ft.fuel_type,
                nr_latest.closing_digital_reading AS latest_closing_digital_reading,
                nr_latest.closing_mechanical_reading AS latest_closing_mechanical_reading
         FROM nozzles nz
         JOIN machines mc ON nz.machine_id = mc.id
         LEFT JOIN fuel_tanks ft ON nz.tank_id = ft.id
         LEFT JOIN (
           SELECT nr1.nozzle_id,
                  nr1.closing_digital_reading,
                  nr1.closing_mechanical_reading
           FROM nozzle_readings nr1
           INNER JOIN (
             SELECT nozzle_id, MAX(id) AS max_id
             FROM nozzle_readings
             WHERE Active = 1
             GROUP BY nozzle_id
           ) latest ON latest.nozzle_id = nr1.nozzle_id AND latest.max_id = nr1.id
           WHERE nr1.Active = 1
         ) nr_latest ON nr_latest.nozzle_id = nz.id
         WHERE mc.pump_id = ?
         ORDER BY mc.machine_number, nz.nozzle_number`,
        [id]
      ),
      connection.execute(
        `SELECT ps.staffid, s.name, s.phone, s.designation, s.role
         FROM pump_staff ps
         JOIN staff s ON s.id = ps.staffid
         WHERE ps.pumpid = ? AND ps.Active = 1`,
        [id]
      ).catch(() => [[]])
    ]);

    if (!pumpRows || pumpRows.length === 0) {
      return res.status(404).json({ message: 'Pump not found' });
    }

    const pump = pumpRows[0];
    const tanks = tankRows || [];
    const machines = (machineRows || []).map((mc) => ({
      ...mc,
      nozzles: (nozzleRows || []).filter((nz) => nz.machine_id === mc.id)
    }));
    const staff = staffRows || [];

    res.json({ pump, tanks, machines, staff });
  } catch (err) {
    console.error('Error fetching pump details:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

exports.createPump = async (req, res) => {
  const payload = req.body || {};
  const pump = payload.pump || {};
  const tanks = Array.isArray(payload.tanks) ? payload.tanks : [];
  const machines = Array.isArray(payload.machines) ? payload.machines : [];
  const mobileOilStockItems = Array.isArray(payload.mobileOilStockItems) ? payload.mobileOilStockItems : [];

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const CB = pump.CB || 'System';

    const [pumpResult] = await connection.execute(
      `INSERT INTO petrol_pumps (name, location, manager_id, Active, CB, CD, MB, MD)
       VALUES (?, ?, ?, 1, ?, NOW(), ?, NOW())`,
      [
        pump.name || null,
        pump.location || null,
        pump.manager_id || null,
        CB,
        CB
      ]
    );

    const pumpId = pumpResult.insertId;

    // Resolve missing tank capacities from tank_types to avoid NULL inserts.
    const tankTypeIdsNeedingCapacity = [...new Set(
      tanks
        .map((t) => (t && t.tank_type_id != null ? Number(t.tank_type_id) : null))
        .filter((id, idx, arr) => Number.isFinite(id) && tanks[idx] && (tanks[idx].capacity == null || String(tanks[idx].capacity).trim() === ''))
    )];

    const tankTypeCapacityById = new Map();
    if (tankTypeIdsNeedingCapacity.length > 0) {
      const placeholders = tankTypeIdsNeedingCapacity.map(() => '?').join(', ');
      const [tankTypeRows] = await connection.execute(
        `SELECT id, total_capacity_liters FROM tank_types WHERE id IN (${placeholders})`,
        tankTypeIdsNeedingCapacity
      );

      (tankTypeRows || []).forEach((row) => {
        const id = Number(row.id);
        const capacity = Number(row.total_capacity_liters);
        if (Number.isFinite(id) && Number.isFinite(capacity) && capacity > 0) {
          tankTypeCapacityById.set(id, capacity);
        }
      });
    }

    // Map tank_number -> fuel_tanks.id for use when saving nozzle tank_id
    const tankNumberToIdMap = new Map();

    for (let index = 0; index < tanks.length; index += 1) {
      const t = tanks[index] || {};
      const fuelTypeKey = String(t.fuel_type || '').trim().toLowerCase();
      const isMobileOilTank = fuelTypeKey === 'mobile oil';
      const tankTypeId = t.tank_type_id != null ? Number(t.tank_type_id) : null;
      const providedCapacity = (t.capacity != null && String(t.capacity).trim() !== '') ? Number(t.capacity) : null;
      const resolvedCapacity = Number.isFinite(providedCapacity)
        ? providedCapacity
        : (Number.isFinite(tankTypeId) ? tankTypeCapacityById.get(tankTypeId) : null);

      if (!isMobileOilTank && (!Number.isFinite(resolvedCapacity) || resolvedCapacity <= 0)) {
        const validationError = new Error(`Tank capacity is required for tank #${index + 1}`);
        validationError.statusCode = 400;
        throw validationError;
      }

      const currentLevel = t.current_level != null ? Number(t.current_level) : 0;
      const lowAlertLevel = t.low_alert_level != null ? Number(t.low_alert_level) : 0;

      const [tankInsertResult] = await connection.execute(
        `INSERT INTO fuel_tanks (
           pump_id, tank_type_id, fuel_type, capacity, current_level, low_alert_level, tank_number,
           Active, CB, CD, MB, MD
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
        [
          pumpId,
          Number.isFinite(tankTypeId) ? tankTypeId : null,
          t.fuel_type || null,
          isMobileOilTank ? null : resolvedCapacity,
          Number.isFinite(currentLevel) ? currentLevel : 0,
          Number.isFinite(lowAlertLevel) ? lowAlertLevel : 0,
          t.tank_number != null ? t.tank_number : null,
          CB,
          CB
        ]
      );
      if (t.tank_number != null && tankInsertResult && tankInsertResult.insertId) {
        tankNumberToIdMap.set(String(t.tank_number), tankInsertResult.insertId);
      }
    }

    for (const m of machines) {
      const [machineResult] = await connection.execute(
        `INSERT INTO machines (
           pump_id, machine_number,
           Active, CB, CD, MB, MD
         ) VALUES (?, ?, 1, ?, NOW(), ?, NOW())`,
        [
          pumpId,
          m.machine_number != null ? m.machine_number : null,
          CB,
          CB
        ]
      );

      const machineId = machineResult.insertId;
      const machineTankId = m.tank_number != null ? (tankNumberToIdMap.get(String(m.tank_number)) || null) : null;
      const nozzles = Array.isArray(m.nozzles) ? m.nozzles : [];

      for (const nz of nozzles) {
        const initDigital = nz.initial_reading_digital != null ? nz.initial_reading_digital : 0;
        const initMech = nz.initial_reading_mechanical != null ? nz.initial_reading_mechanical : 0;
        const currDigital = nz.current_reading_digital != null ? nz.current_reading_digital : 0;
        const currMech = nz.current_reading_mechanical != null ? nz.current_reading_mechanical : 0;
        await connection.execute(
          `INSERT INTO nozzles (
             machine_id, tank_id, nozzle_number, nozzle_type,
             initial_reading_digital, initial_reading_mechanical,
             current_reading_digital, current_reading_mechanical,
             Active, CB, CD, MB, MD
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
          [
            machineId,
            machineTankId,
            nz.nozzle_number != null ? nz.nozzle_number : null,
            nz.nozzle_type || null,
            initDigital,
            initMech,
            currDigital,
            currMech,
            CB,
            CB
          ]
        );
      }
    }

    // Insert pump_staff assignments
    const staffIds = Array.isArray(payload.staffIds) ? payload.staffIds.map(Number).filter(Boolean) : [];
    for (const staffId of staffIds) {
      try {
        await connection.execute(
          `INSERT INTO pump_staff (pumpid, staffid, Active, CB, CD, MB, MD) VALUES (?, ?, 1, ?, NOW(), ?, NOW())`,
          [pumpId, staffId, CB, CB]
        );
      } catch (staffErr) {
        if (staffErr.code !== 'ER_NO_SUCH_TABLE') throw staffErr;
      }
    }

    await upsertMobileOilPurchaseRows(connection, {
      pumpId,
      stockItems: mobileOilStockItems,
      actorName: CB
    });

    await connection.commit();

    res.json({
      message: 'Pump created successfully',
      pump_id: pumpId
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (e) {
        console.error('Error rolling back transaction:', e);
      }
    }
    console.error('Error creating pump:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ message: 'Required tables do not exist. Please verify database schema.' });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ message: err.message });
    }
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Duplicate tank, machine, or nozzle configuration detected' });
    }
    res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

exports.updatePump = async (req, res) => {
  const payload = req.body || {};
  const pump = payload.pump || {};
  const pumpId = payload.id || pump.id;
  const tanks = Array.isArray(payload.tanks) ? payload.tanks : [];
  const machines = Array.isArray(payload.machines) ? payload.machines : [];
  const mobileOilStockItems = Array.isArray(payload.mobileOilStockItems) ? payload.mobileOilStockItems : [];

  // Support legacy format (direct fields in body)
  const name = pump.name || payload.name;
  const location = pump.location || payload.location;
  const manager_id = pump.manager_id !== undefined ? pump.manager_id : payload.manager_id;
  const Previous_Dues = payload.Previous_Dues;
  const is_active = payload.is_active;
  const active = payload.active;

  if (!pumpId) {
    return res.status(400).json({ message: 'Pump ID is required' });
  }
  if (!name && !pump.name) {
    return res.status(400).json({ message: 'Pump name is required' });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const MB = pump.MB || 'System';
    const activeValue = is_active !== undefined ? is_active : (active !== undefined ? active : 1);
    const previousDues = parseFloat(Previous_Dues || 0) || 0;

    // Update pump basic info
    let updateQuery = `
      UPDATE petrol_pumps SET 
        name = ?,
        location = ?,
        manager_id = ?,
        Active = ?,
        MB = ?,
        MD = NOW()
    `;
    let updateParams = [
      name || pump.name,
      location !== undefined ? location : pump.location,
      manager_id !== undefined ? manager_id : pump.manager_id,
      activeValue ? 1 : 0,
      MB
    ];

    // Try to include Previous_Dues if column exists
    try {
      updateQuery = `
        UPDATE petrol_pumps SET 
          name = ?,
          location = ?,
          manager_id = ?,
          Previous_Dues = ?,
          Active = ?,
          MB = ?,
          MD = NOW()
        WHERE id = ?
      `;
      updateParams = [
        name || pump.name,
        location !== undefined ? location : pump.location,
        manager_id !== undefined ? manager_id : pump.manager_id,
        previousDues,
        activeValue ? 1 : 0,
        MB,
        pumpId
      ];
      await conn.execute(updateQuery, updateParams);
    } catch (colErr) {
      if (colErr.code === 'ER_BAD_FIELD_ERROR' && colErr.sqlMessage && colErr.sqlMessage.includes('Previous_Dues')) {
        updateQuery = `
          UPDATE petrol_pumps SET 
            name = ?,
            location = ?,
            manager_id = ?,
            Active = ?,
            MB = ?,
            MD = NOW()
          WHERE id = ?
        `;
        updateParams = [
          name || pump.name,
          location !== undefined ? location : pump.location,
          manager_id !== undefined ? manager_id : pump.manager_id,
          activeValue ? 1 : 0,
          MB,
          pumpId
        ];
        await conn.execute(updateQuery, updateParams);
      } else {
        throw colErr;
      }
    } finally {
      if (conn) conn.release();
    }

    // If tanks/machines are provided, update them (full replacement)
    if (tanks.length > 0 || machines.length > 0) {
      // Get existing tank IDs to track which ones to keep
      const [existingTanks] = await conn.execute(
        `SELECT id, fuel_type, tank_number FROM fuel_tanks WHERE pump_id = ?`,
        [pumpId]
      );
      const existingTankMap = new Map();
      (existingTanks || []).forEach(t => {
        const key = `${t.fuel_type}-${t.tank_number}`;
        existingTankMap.set(key, t.id);
      });

      // Process tanks: update existing or insert new
      const processedTankIds = new Set();
      // Map tank_number -> fuel_tanks.id for use when saving nozzle tank_id
      const tankNumberToIdMap = new Map();
      for (const t of tanks) {
        let existingId = t.id ? Number(t.id) : null;
        if (!existingId) {
          const key = `${t.fuel_type || ''}-${t.tank_number || ''}`;
          existingId = existingTankMap.get(key);
        }

        if (existingId) {
          // Update existing tank
          await conn.execute(
            `UPDATE fuel_tanks SET
               tank_type_id = ?,
               capacity = ?,
               current_level = ?,
               low_alert_level = ?,
               Active = 1,
               MB = ?,
               MD = NOW()
             WHERE id = ?`,
            [
              t.tank_type_id != null ? Number(t.tank_type_id) : null,
              t.capacity != null ? t.capacity : null,
              t.current_level != null ? t.current_level : 0,
              t.low_alert_level != null ? t.low_alert_level : 0,
              MB,
              existingId
            ]
          );
          processedTankIds.add(existingId);
          if (t.tank_number != null) {
            tankNumberToIdMap.set(String(t.tank_number), existingId);
          }
        } else {
          // The unique constraint applies to all rows regardless of Active status
          const [conflictingTanks] = await conn.execute(
            `SELECT id FROM fuel_tanks 
             WHERE pump_id = ? AND fuel_type = ? AND tank_number = ?
             LIMIT 1`,
            [pumpId, t.fuel_type || null, t.tank_number != null ? t.tank_number : null]
          );
          if (conflictingTanks && conflictingTanks.length > 0) {
            // Delete conflicting tank completely
            await conn.execute(`DELETE FROM fuel_tanks WHERE id = ?`, [conflictingTanks[0].id]);
          }

          // Insert new tank
          try {
            const [insertResult] = await conn.execute(
              `INSERT INTO fuel_tanks (
                 pump_id, tank_type_id, fuel_type, capacity, current_level, low_alert_level, tank_number,
                 Active, CB, CD, MB, MD
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
              [
                pumpId,
                t.tank_type_id != null ? Number(t.tank_type_id) : null,
                t.fuel_type || null,
                t.capacity != null ? t.capacity : null,
                t.current_level != null ? t.current_level : 0,
                t.low_alert_level != null ? t.low_alert_level : 0,
                t.tank_number != null ? t.tank_number : null,
                MB,
                MB
              ]
            );
            if (insertResult && insertResult.insertId) {
              processedTankIds.add(Number(insertResult.insertId));
            }
          } catch (insertErr) {
            // If insert fails due to duplicate, delete conflicting tank and retry
            if (insertErr.code === 'ER_DUP_ENTRY') {
              const [conflictingTanks] = await conn.execute(
                `SELECT id FROM fuel_tanks 
                 WHERE pump_id = ? AND fuel_type = ? AND tank_number = ?
                 LIMIT 1`,
                [pumpId, t.fuel_type || null, t.tank_number != null ? t.tank_number : null]
              );
              if (conflictingTanks && conflictingTanks.length > 0) {
                await conn.execute(`DELETE FROM fuel_tanks WHERE id = ?`, [conflictingTanks[0].id]);
                // Retry insert
                const [retryInsertResult] = await conn.execute(
                  `INSERT INTO fuel_tanks (
                     pump_id, tank_type_id, fuel_type, capacity, current_level, low_alert_level, tank_number,
                     Active, CB, CD, MB, MD
                   ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
                  [
                    pumpId,
                    t.tank_type_id != null ? Number(t.tank_type_id) : null,
                    t.fuel_type || null,
                    t.capacity != null ? t.capacity : null,
                    t.current_level != null ? t.current_level : 0,
                    t.low_alert_level != null ? t.low_alert_level : 0,
                    t.tank_number != null ? t.tank_number : null,
                    MB,
                    MB
                  ]
                );
                if (retryInsertResult && retryInsertResult.insertId) {
                  processedTankIds.add(Number(retryInsertResult.insertId));
                }
              } else {
                throw insertErr;
              }
            } else {
              throw insertErr;
            }
          }
        }
      }

      // Soft delete tanks that are not in the new list
      if (processedTankIds.size > 0) {
        const placeholders = Array.from(processedTankIds).map(() => '?').join(',');
        await conn.execute(
          `UPDATE fuel_tanks SET Active = 0, MD = NOW() 
           WHERE pump_id = ? AND id NOT IN (${placeholders})`,
          [pumpId, ...Array.from(processedTankIds)]
        );
      } else {
        // If no tanks were processed, soft delete all
        await conn.execute(
          `UPDATE fuel_tanks SET Active = 0, MD = NOW() WHERE pump_id = ?`,
          [pumpId]
        );
      }

      // Get existing machine IDs to track which ones to keep (including inactive)
      const [existingMachines] = await conn.execute(
        `SELECT id, machine_number FROM machines WHERE pump_id = ?`,
        [pumpId]
      );

      // Query final tank_number -> tank_id map from DB (after all tank inserts/updates)
      const [updatedTankRows] = await conn.execute(
        `SELECT id, tank_number FROM fuel_tanks WHERE pump_id = ? AND Active = 1 AND tank_number IS NOT NULL`,
        [pumpId]
      );
      (updatedTankRows || []).forEach(row => {
        tankNumberToIdMap.set(String(row.tank_number), row.id);
      });

      const existingMachineMap = new Map();
      (existingMachines || []).forEach(m => {
        const key = `${m.machine_number}`;
        existingMachineMap.set(key, m.id);
      });

      // Process machines: update existing or insert new
      const processedMachineIds = new Set();
      for (const m of machines) {
        const key = `${m.machine_number || ''}`;
        const existingMachineId = existingMachineMap.get(key);

        let machineId;
        if (existingMachineId) {
          // Update existing machine
          await conn.execute(
            `UPDATE machines SET Active = 1, MB = ?, MD = NOW() WHERE id = ?`,
            [MB, existingMachineId]
          );
          machineId = existingMachineId;
          processedMachineIds.add(existingMachineId);
        } else {
          // Before inserting, check for conflicting machines (including inactive ones)
          // The unique constraint applies to all rows regardless of Active status
          const [conflictingMachines] = await conn.execute(
            `SELECT id FROM machines 
             WHERE pump_id = ? AND machine_number = ?
             LIMIT 1`,
            [pumpId, m.machine_number != null ? m.machine_number : null]
          );
          if (conflictingMachines && conflictingMachines.length > 0) {
            // Delete conflicting machine completely
            await conn.execute(`DELETE FROM machines WHERE id = ?`, [conflictingMachines[0].id]);
            // Also delete its nozzles
            await conn.execute(`DELETE FROM nozzles WHERE machine_id = ?`, [conflictingMachines[0].id]);
          }

          // Insert new machine
          try {
            const [machineResult] = await conn.execute(
              `INSERT INTO machines (
                 pump_id, machine_number,
                 Active, CB, CD, MB, MD
               ) VALUES (?, ?, 1, ?, NOW(), ?, NOW())`,
              [
                pumpId,
                m.machine_number != null ? m.machine_number : null,
                MB,
                MB
              ]
            );
            machineId = machineResult.insertId;
          } catch (insertErr) {
            // If insert fails due to duplicate, delete conflicting machine and retry
            if (insertErr.code === 'ER_DUP_ENTRY') {
              const [conflictingMachines] = await conn.execute(
                `SELECT id FROM machines 
                 WHERE pump_id = ? AND machine_number = ?
                 LIMIT 1`,
                [pumpId, m.machine_number != null ? m.machine_number : null]
              );
              if (conflictingMachines && conflictingMachines.length > 0) {
                const conflictId = conflictingMachines[0].id;
                // Delete conflicting machine and its nozzles
                await conn.execute(`DELETE FROM nozzles WHERE machine_id = ?`, [conflictId]);
                await conn.execute(`DELETE FROM machines WHERE id = ?`, [conflictId]);
                // Retry insert
                const [machineResult] = await conn.execute(
                  `INSERT INTO machines (
                     pump_id, machine_number,
                     Active, CB, CD, MB, MD
                   ) VALUES (?, ?, 1, ?, NOW(), ?, NOW())`,
                  [
                    pumpId,
                    m.machine_number != null ? m.machine_number : null,
                    MB,
                    MB
                  ]
                );
                machineId = machineResult.insertId;
              } else {
                throw insertErr;
              }
            } else {
              throw insertErr;
            }
          }
        }

        // Get existing nozzles for this machine
        const [existingNozzles] = await conn.execute(
          `SELECT id, nozzle_number FROM nozzles WHERE machine_id = ?`,
          [machineId]
        );
        // Map by nozzle_number to id (for finding nozzle to update)
        const existingNozzleByNumber = new Map();
        (existingNozzles || []).forEach(nz => {
          existingNozzleByNumber.set(nz.nozzle_number, nz.id);
        });

        // Process nozzles: update existing or insert new
        const processedNozzleIds = new Set();
        const nozzles = Array.isArray(m.nozzles) ? m.nozzles : [];
        const machineTankId = m.tank_number != null ? (tankNumberToIdMap.get(String(m.tank_number)) || null) : null;

        for (const nz of nozzles) {
          const nozzleNumber = nz.nozzle_number != null ? nz.nozzle_number : null;
          const existingNozzleId = existingNozzleByNumber.get(nozzleNumber);

          if (existingNozzleId) {
            // Update existing nozzle (by nozzle_number)
            try {
              const initDigital = nz.initial_reading_digital != null ? nz.initial_reading_digital : 0;
              const initMech = nz.initial_reading_mechanical != null ? nz.initial_reading_mechanical : 0;
              const currDigital = nz.current_reading_digital != null ? nz.current_reading_digital : 0;
              const currMech = nz.current_reading_mechanical != null ? nz.current_reading_mechanical : 0;
              await conn.execute(
                `UPDATE nozzles SET
                   tank_id = ?,
                   nozzle_type = ?,
                   initial_reading_digital = ?,
                   initial_reading_mechanical = ?,
                   current_reading_digital = ?,
                   current_reading_mechanical = ?,
                   Active = 1,
                   MB = ?,
                   MD = NOW()
                 WHERE id = ?`,
                [
                  machineTankId,
                  nz.nozzle_type || null,
                  initDigital,
                  initMech,
                  currDigital,
                  currMech,
                  MB,
                  existingNozzleId
                ]
              );
              processedNozzleIds.add(existingNozzleId);
            } catch (updateErr) {
              // If update fails due to duplicate, delete the conflicting nozzle and retry
              if (updateErr.code === 'ER_DUP_ENTRY') {
                const [conflictingNozzles] = await conn.execute(
                  `SELECT id FROM nozzles 
                   WHERE machine_id = ? AND nozzle_number = ? AND id != ?
                   LIMIT 1`,
                  [machineId, nozzleNumber, existingNozzleId]
                );
                if (conflictingNozzles && conflictingNozzles.length > 0) {
                  const conflictId = conflictingNozzles[0].id;
                  await conn.execute(`DELETE FROM nozzles WHERE id = ?`, [conflictId]);
                  const initDigital = nz.initial_reading_digital != null ? nz.initial_reading_digital : 0;
                  const initMech = nz.initial_reading_mechanical != null ? nz.initial_reading_mechanical : 0;
                  const currDigital = nz.current_reading_digital != null ? nz.current_reading_digital : 0;
                  const currMech = nz.current_reading_mechanical != null ? nz.current_reading_mechanical : 0;
                  // Retry the update
                  await conn.execute(
                    `UPDATE nozzles SET
                       tank_id = ?,
                       nozzle_type = ?,
                       initial_reading_digital = ?,
                       initial_reading_mechanical = ?,
                       current_reading_digital = ?,
                       current_reading_mechanical = ?,
                       Active = 1,
                       MB = ?,
                       MD = NOW()
                     WHERE id = ?`,
                    [
                      machineTankId,
                      nz.nozzle_type || null,
                      initDigital,
                      initMech,
                      currDigital,
                      currMech,
                      MB,
                      existingNozzleId
                    ]
                  );
                  processedNozzleIds.add(existingNozzleId);
                } else {
                  throw updateErr;
                }
              } else {
                throw updateErr;
              }
            }
          } else {
            // Insert new nozzle
            try {
              const initDigital = nz.initial_reading_digital != null ? nz.initial_reading_digital : 0;
              const initMech = nz.initial_reading_mechanical != null ? nz.initial_reading_mechanical : 0;
              const currDigital = nz.current_reading_digital != null ? nz.current_reading_digital : 0;
              const currMech = nz.current_reading_mechanical != null ? nz.current_reading_mechanical : 0;
              await conn.execute(
                `INSERT INTO nozzles (
                   machine_id, tank_id, nozzle_number, nozzle_type,
                   initial_reading_digital, initial_reading_mechanical,
                   current_reading_digital, current_reading_mechanical,
                   Active, CB, CD, MB, MD
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
                [
                  machineId,
                  machineTankId,
                  nozzleNumber,
                  nz.nozzle_type || null,
                  initDigital,
                  initMech,
                  currDigital,
                  currMech,
                  MB,
                  MB
                ]
              );
            } catch (insertErr) {
              // If insert fails due to duplicate, try to update/reactivate the existing one instead
              if (insertErr.code === 'ER_DUP_ENTRY') {
                const [dupNozzles] = await conn.execute(
                  `SELECT id FROM nozzles 
                   WHERE machine_id = ? AND nozzle_number = ?
                   LIMIT 1`,
                  [machineId, nozzleNumber]
                );
                if (dupNozzles && dupNozzles.length > 0) {
                  const dupId = dupNozzles[0].id;
                  const initDigital = nz.initial_reading_digital != null ? nz.initial_reading_digital : 0;
                  const initMech = nz.initial_reading_mechanical != null ? nz.initial_reading_mechanical : 0;
                  const currDigital = nz.current_reading_digital != null ? nz.current_reading_digital : 0;
                  const currMech = nz.current_reading_mechanical != null ? nz.current_reading_mechanical : 0;
                  await conn.execute(
                    `UPDATE nozzles SET
                       tank_id = ?,
                       nozzle_type = ?,
                       initial_reading_digital = ?,
                       initial_reading_mechanical = ?,
                       current_reading_digital = ?,
                       current_reading_mechanical = ?,
                       Active = 1,
                       MB = ?,
                       MD = NOW()
                     WHERE id = ?`,
                    [
                      machineTankId,
                      nz.nozzle_type || null,
                      initDigital,
                      initMech,
                      currDigital,
                      currMech,
                      MB,
                      dupId
                    ]
                  );
                  processedNozzleIds.add(dupId);
                } else {
                  throw insertErr;
                }
              } else {
                throw insertErr;
              }
            } finally {
              if (conn) conn.release();
            }
          }
        }

        // Soft delete nozzles that are not in the new list for this machine
        if (processedNozzleIds.size > 0) {
          const nozzlePlaceholders = Array.from(processedNozzleIds).map(() => '?').join(',');
          await conn.execute(
            `UPDATE nozzles SET Active = 0, MD = NOW() 
             WHERE machine_id = ? AND id NOT IN (${nozzlePlaceholders})`,
            [machineId, ...Array.from(processedNozzleIds)]
          );
        } else if (nozzles.length === 0) {
          // If no nozzles provided, soft delete all nozzles for this machine
          await conn.execute(
            `UPDATE nozzles SET Active = 0, MD = NOW() WHERE machine_id = ?`,
            [machineId]
          );
        }
      }

      // Soft delete machines that are not in the new list
      if (processedMachineIds.size > 0) {
        const machinePlaceholders = Array.from(processedMachineIds).map(() => '?').join(',');
        await conn.execute(
          `UPDATE machines SET Active = 0, MD = NOW() 
           WHERE pump_id = ? AND id NOT IN (${machinePlaceholders})`,
          [pumpId, ...Array.from(processedMachineIds)]
        );

        // Also soft delete nozzles for deleted machines
        await conn.execute(
          `UPDATE nozzles nz 
           JOIN machines mc ON nz.machine_id = mc.id 
           SET nz.Active = 0, nz.MD = NOW() 
           WHERE mc.pump_id = ? AND mc.id NOT IN (${machinePlaceholders})`,
          [pumpId, ...Array.from(processedMachineIds)]
        );
      } else if (machines.length === 0) {
        // If no machines provided, soft delete all machines and their nozzles
        await conn.execute(
          `UPDATE nozzles nz 
           JOIN machines mc ON nz.machine_id = mc.id 
           SET nz.Active = 0, nz.MD = NOW() 
           WHERE mc.pump_id = ?`,
          [pumpId]
        );
        await conn.execute(
          `UPDATE machines SET Active = 0, MD = NOW() WHERE pump_id = ?`,
          [pumpId]
        );
      }
    }

    // Differential update pump_staff
    if (payload.staffIds !== undefined) {
      const newStaffIds = (Array.isArray(payload.staffIds) ? payload.staffIds : []).map(Number).filter(Boolean);
      try {
        const [existingStaff] = await conn.execute(
          `SELECT staffid FROM pump_staff WHERE pumpid = ? AND Active = 1`,
          [pumpId]
        );
        const existingIds = (existingStaff || []).map(r => Number(r.staffid));

        // Deactivate removed staff
        for (const existId of existingIds) {
          if (!newStaffIds.includes(existId)) {
            await conn.execute(
              `UPDATE pump_staff SET Active = 0, MD = NOW(), MB = ? WHERE pumpid = ? AND staffid = ?`,
              [MB, pumpId, existId]
            );
          }
        }

        // Insert newly added staff
        for (const newId of newStaffIds) {
          if (!existingIds.includes(newId)) {
            await conn.execute(
              `INSERT INTO pump_staff (pumpid, staffid, Active, CB, CD, MB, MD) VALUES (?, ?, 1, ?, NOW(), ?, NOW())`,
              [pumpId, newId, MB, MB]
            );
          }
        }
      } catch (staffErr) {
        if (staffErr.code !== 'ER_NO_SUCH_TABLE') throw staffErr;
      }
    }

    await upsertMobileOilPurchaseRows(conn, {
      pumpId,
      stockItems: mobileOilStockItems,
      actorName: MB
    });

    await conn.commit();

    res.json({
      message: 'Pump updated successfully',
      pump_id: pumpId
    });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (e) {
        console.error('Error rolling back transaction:', e);
      }
    }
    console.error('Error updating pump:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ message: 'Required tables do not exist. Please verify database schema.' });
    }
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'Duplicate tank, machine, or nozzle configuration detected' });
    }
    res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (conn) conn.release();
  }
};

exports.deletePump = async (req, res) => {
  try {
    const id = Number(req.body?.id);
    const role = req.body?.role;
    const MB = req.body?.MB || req.body?.username || 'System';

    if (!id) {
      return res.status(400).json({ message: 'Pump ID is required' });
    }

    if (!isAdminRole(role)) {
      return res.status(403).json({ message: 'Only admin can delete petrol pumps' });
    }

    const [result] = await db.execute(
      `UPDATE petrol_pumps
       SET Active = 0, MB = ?, MD = NOW()
       WHERE id = ? AND Active = 1`,
      [MB, id]
    );
    const [tankresult] = await db.execute(
      `UPDATE fuel_tanks
       SET Active = 0, MB = ?, MD = NOW()
       WHERE pump_id = ? AND Active = 1`,
      [MB, id]
    );

    // Get machine ids for the given pump_id
    /*  const [machines] = await db.execute(
       `SELECT id FROM machines WHERE pump_id = ? AND Active = 1`,
       [id]
     );
     const machineIds = machines.map(row => row.id);
 
     if (machineIds.length) {
       // Update nozzles for those machine ids
       await db.execute(
         `UPDATE nozzles SET Active = 0, MB = ?, MD = NOW() WHERE machine_id IN (?) AND Active = 1`,
         [MB, machineIds]
       );
     } */
    await db.execute(
      `UPDATE nozzles n
   JOIN machines m ON n.machine_id = m.id
   SET n.Active = 0, n.MB = ?, n.MD = NOW()
   WHERE m.pump_id = ? AND n.Active = 1 AND m.Active = 1`,
      [MB, id]
    );
    const [machinesresult] = await db.execute(
      `UPDATE machines
       SET Active = 0, MB = ?, MD = NOW()
       WHERE pump_id = ? AND Active = 1`,
      [MB, id]
    );



    if (!result || result.affectedRows === 0) {
      return res.status(404).json({ message: 'Pump not found or already inactive' });
    }

    return res.status(200).json({ message: 'Pump deleted successfully' });
  } catch (err) {
    console.error('Error deleting pump:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

// Get tank inventory with low level alerts.
// Mobile Oil current level is sourced from the latest daily_tank_inventory row when available.
exports.getTankInventory = async (req, res) => {

  let connection;
  try {
    connection = await db.getConnection();
    const pumpId = req.query.pump_id;

    let query = `
      SELECT 
        ft.id,
        ft.pump_id,
        ft.tank_type_id,
        ft.fuel_type,
        ft.capacity,
        ft.current_level,
        ft.low_alert_level,
        ft.tank_number,
        ft.Active,
        pp.name as pump_name,
        tt.total_capacity_liters,
        tt.max_dip_mm,
        COALESCE(pdr_latest.volume_liters, 0) AS last_physical_dip_liters,
        CASE 
          WHEN ft.current_level <= ft.low_alert_level THEN 1
          ELSE 0
        END as is_low_level,
        CASE 
          WHEN ft.current_level <= ft.low_alert_level THEN 'Low Level Alert'
          ELSE 'Normal'
        END as alert_status,
        ROUND((ft.current_level / COALESCE(tt.total_capacity_liters, ft.capacity)) * 100, 2) as percentage_full
      FROM fuel_tanks ft
      LEFT JOIN petrol_pumps pp ON ft.pump_id = pp.id
      LEFT JOIN tank_types tt ON ft.tank_type_id = tt.id
      LEFT JOIN (
        SELECT p1.tank_id, p1.volume_liters
        FROM physical_dip_readings p1
        INNER JOIN (
          SELECT
            tank_id,
            MAX(COALESCE(reading_time, CD)) AS latest_reading_time
          FROM physical_dip_readings
          WHERE Active = 1
          GROUP BY tank_id
        ) px ON px.tank_id = p1.tank_id
            AND COALESCE(p1.reading_time, p1.CD) = px.latest_reading_time
        WHERE p1.Active = 1
      ) pdr_latest ON pdr_latest.tank_id = ft.id
      WHERE ft.Active = 1
    `;

    const params = [];

    if (pumpId) {
      query += ' AND ft.pump_id = ?';
      params.push(pumpId);
    }

    query += ' ORDER BY ft.pump_id, ft.fuel_type, ft.tank_number';

    let rows = [];
    try {
      const [resultRows] = await connection.execute(query, params);
      rows = resultRows || [];
    } catch (queryErr) {
      if (queryErr.code !== 'ER_BAD_FIELD_ERROR' && queryErr.code !== 'ER_NO_SUCH_TABLE') {
        throw queryErr;
      }

      const fallbackQuery = `
        SELECT 
          ft.id,
          ft.pump_id,
          NULL as tank_type_id,
          ft.fuel_type,
          ft.capacity,
          ft.current_level,
          ft.low_alert_level,
          ft.tank_number,
          ft.Active,
          pp.name as pump_name,
          NULL as total_capacity_liters,
          NULL as max_dip_mm,
          COALESCE(pdr_latest.volume_liters, 0) AS last_physical_dip_liters,
          CASE 
            WHEN ft.current_level <= ft.low_alert_level THEN 1
            ELSE 0
          END as is_low_level,
          CASE 
            WHEN ft.current_level <= ft.low_alert_level THEN 'Low Level Alert'
            ELSE 'Normal'
          END as alert_status,
          ROUND((ft.current_level / ft.capacity) * 100, 2) as percentage_full
        FROM fuel_tanks ft
        LEFT JOIN petrol_pumps pp ON ft.pump_id = pp.id
        LEFT JOIN (
          SELECT p1.tank_id, p1.volume_liters
          FROM physical_dip_readings p1
          INNER JOIN (
            SELECT
              tank_id,
              MAX(COALESCE(reading_time, CD)) AS latest_reading_time
            FROM physical_dip_readings
            WHERE Active = 1
            GROUP BY tank_id
          ) px ON px.tank_id = p1.tank_id
              AND COALESCE(p1.reading_time, p1.CD) = px.latest_reading_time
          WHERE p1.Active = 1
        ) pdr_latest ON pdr_latest.tank_id = ft.id
        WHERE ft.Active = 1
        ${pumpId ? ' AND ft.pump_id = ?' : ''}
        ORDER BY ft.pump_id, ft.fuel_type, ft.tank_number
      `;

      const [fallbackRows] = await connection.execute(fallbackQuery, params);
      rows = fallbackRows || [];
    }

    // For mobile oil, prefer latest daily_tank_inventory dip snapshot over static fuel_tanks.current_level.
    const mobileTankLevelById = {};
    try {
      const mobileSnapshotQuery = `
        SELECT
          dti.tank_id,
          dti.closing_level,
          dti.opening_level,
          dse.entry_date,
          dti.id,
         dti.received_quantity,
        FROM daily_tank_inventory dti
        INNER JOIN daily_sales_entries dse ON dse.id = dti.daily_entry_id
        INNER JOIN fuel_tanks ft ON ft.id = dti.tank_id
        WHERE dti.Active = 1
          AND dse.Active = 1
          AND ft.Active = 1
          AND LOWER(ft.fuel_type) LIKE '%mobile%'
          ${pumpId ? 'AND ft.pump_id = ?' : ''}
        ORDER BY dse.entry_date DESC, dti.id DESC
      `;

      const [mobileSnapshotRows] = await connection.execute(mobileSnapshotQuery, pumpId ? [pumpId] : []);
      for (const row of (mobileSnapshotRows || [])) {
        const tankId = Number(row.tank_id || 0);
        if (!tankId || mobileTankLevelById[tankId] !== undefined) {
          continue;
        }
        const closing = row.closing_level;
        const opening = row.opening_level;
        const received = row.received_quantity;
        const level = (closing != null ? Number(closing) : (opening != null ? Number(opening) : 0)) + (received != null ? Number(received) : 0);
        mobileTankLevelById[tankId] = Number.isFinite(level) ? Math.max(0, level) : 0;
      }
    } catch (snapshotErr) {
      if (
        snapshotErr.code !== 'ER_NO_SUCH_TABLE' &&
        snapshotErr.code !== 'ER_BAD_FIELD_ERROR' &&
        snapshotErr.code !== 'ER_PARSE_ERROR'
      ) {
        throw snapshotErr;
      }
    } finally {
      if (connection) connection.release();
    }

    const tanks = (rows || []).map(row => {
      const fuelType = String(row.fuel_type || '');
      const isMobileOil = fuelType.toLowerCase().includes('mobile');
      const tankId = Number(row.id || 0);
      const baseCurrentLevel = parseFloat(row.current_level) || 0;
      const effectiveCurrentLevel = isMobileOil && mobileTankLevelById[tankId] !== undefined
        ? Number(mobileTankLevelById[tankId])
        : baseCurrentLevel;
      const capacity = parseFloat(row.capacity) || 0;
      const totalCapacityLiters = parseFloat(row.total_capacity_liters) || 0;
      const denominator = totalCapacityLiters || capacity;
      const percentageFull = denominator > 0 ? Number(((effectiveCurrentLevel / denominator) * 100).toFixed(2)) : 0;

      return {
        id: row.id,
        pump_id: row.pump_id,
        pump_name: row.pump_name,
        tank_type_id: row.tank_type_id,
        total_capacity_liters: totalCapacityLiters,
        max_dip_mm: parseFloat(row.max_dip_mm) || 0,
        fuel_type: fuelType,
        capacity,
        current_level: effectiveCurrentLevel,
        last_physical_dip_liters: parseFloat(row.last_physical_dip_liters) || 0,
        low_alert_level: parseFloat(row.low_alert_level) || 0,
        tank_number: row.tank_number,
        active: row.Active === 1,
        is_low_level: effectiveCurrentLevel <= (parseFloat(row.low_alert_level) || 0),
        alert_status: effectiveCurrentLevel <= (parseFloat(row.low_alert_level) || 0) ? 'Low Level Alert' : 'Normal',
        percentage_full: percentageFull
      };
    });

    // Count low level alerts
    const lowLevelCount = tanks.filter(t => t.is_low_level).length;

    res.json({
      tanks,
      total_tanks: tanks.length,
      low_level_count: lowLevelCount,
      has_alerts: lowLevelCount > 0
    });
  } catch (err) {
    console.error('Error fetching tank inventory:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ tanks: [], total_tanks: 0, low_level_count: 0, has_alerts: false });
    }
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

// Get volume liters from dip chart by tank type and dip reading (mm)
exports.getDipVolumeByType = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const tankTypeId = Number(req.query.tank_type_id);
    const dipMm = Number(req.query.dip_mm);

    if (!tankTypeId || Number.isNaN(tankTypeId)) {
      return res.status(400).json({ message: 'tank_type_id is required' });
    }
    if (Number.isNaN(dipMm) || dipMm < 0) {
      return res.status(400).json({ message: 'valid dip_mm is required' });
    }

    const [exactRows] = await connection.execute(
      `SELECT volume_liters
       FROM dip_chart
       WHERE tank_type_id = ? AND dip_mm = ? AND Active = 1
       LIMIT 1`,
      [tankTypeId, dipMm]
    );

    if (exactRows && exactRows.length > 0) {
      return res.json({
        tank_type_id: tankTypeId,
        dip_mm: dipMm,
        volume_liters: parseFloat(exactRows[0].volume_liters) || 0,
        source: 'exact'
      });
    }

    const [lowerRows] = await connection.execute(
      `SELECT dip_mm, volume_liters
       FROM dip_chart
       WHERE tank_type_id = ? AND dip_mm <= ? AND Active = 1
       ORDER BY dip_mm DESC
       LIMIT 1`,
      [tankTypeId, dipMm]
    );

    const [upperRows] = await connection.execute(
      `SELECT dip_mm, volume_liters
       FROM dip_chart
       WHERE tank_type_id = ? AND dip_mm >= ? AND Active = 1
       ORDER BY dip_mm ASC
       LIMIT 1`,
      [tankTypeId, dipMm]
    );

    const lower = lowerRows && lowerRows[0] ? lowerRows[0] : null;
    const upper = upperRows && upperRows[0] ? upperRows[0] : null;

    if (!lower && !upper) {
      // Fall back to linear interpolation using tank_types metadata
      const [typeRows] = await connection.execute(
        `SELECT total_capacity_liters, max_dip_mm FROM tank_types WHERE id = ? LIMIT 1`,
        [tankTypeId]
      );
      if (!typeRows || typeRows.length === 0) {
        return res.status(404).json({ message: 'No dip chart data found for this tank type' });
      }
      const maxDip = parseFloat(typeRows[0].max_dip_mm) || 0;
      const maxCapacity = parseFloat(typeRows[0].total_capacity_liters) || 0;
      if (maxDip <= 0 || maxCapacity <= 0) {
        return res.status(404).json({ message: 'No dip chart data found for this tank type' });
      }
      const clampedDip = Math.min(dipMm, maxDip);
      const estimated = Math.round(((clampedDip / maxDip) * maxCapacity) * 100) / 100;
      return res.json({
        tank_type_id: tankTypeId,
        dip_mm: dipMm,
        volume_liters: estimated,
        source: 'estimated'
      });
    }

    if (lower && upper) {
      const lowerDip = parseFloat(lower.dip_mm);
      const upperDip = parseFloat(upper.dip_mm);
      const lowerVol = parseFloat(lower.volume_liters);
      const upperVol = parseFloat(upper.volume_liters);

      if (upperDip === lowerDip) {
        return res.json({
          tank_type_id: tankTypeId,
          dip_mm: dipMm,
          volume_liters: lowerVol || 0,
          source: 'nearest'
        });
      }

      const ratio = (dipMm - lowerDip) / (upperDip - lowerDip);
      const interpolated = lowerVol + (upperVol - lowerVol) * ratio;
      return res.json({
        tank_type_id: tankTypeId,
        dip_mm: dipMm,
        volume_liters: Math.round((interpolated || 0) * 100) / 100,
        source: 'interpolated'
      });
    }

    const fallbackVol = parseFloat((lower || upper).volume_liters) || 0;
    return res.json({
      tank_type_id: tankTypeId,
      dip_mm: dipMm,
      volume_liters: fallbackVol,
      source: 'nearest'
    });
  } catch (err) {
    console.error('Error fetching dip chart volume:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      // dip_chart doesn't exist — fall back to linear estimate from tank_types
      try {
        const [typeRows] = await connection.execute(
          `SELECT total_capacity_liters, max_dip_mm FROM tank_types WHERE id = ? LIMIT 1`,
          [tankTypeId]
        );
        if (typeRows && typeRows.length > 0) {
          const maxDip = parseFloat(typeRows[0].max_dip_mm) || 0;
          const maxCapacity = parseFloat(typeRows[0].total_capacity_liters) || 0;
          if (maxDip > 0 && maxCapacity > 0) {
            const clampedDip = Math.min(dipMm, maxDip);
            const estimated = Math.round(((clampedDip / maxDip) * maxCapacity) * 100) / 100;
            return res.json({
              tank_type_id: tankTypeId,
              dip_mm: dipMm,
              volume_liters: estimated,
              source: 'estimated'
            });
          }
        }
      } catch (_) { /* ignore fallback error */ }
      return res.status(500).json({ message: 'dip_chart table not found' });
    }
    res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Check if dip readings exist for a pump on a given date.
 * Validation is based on DATE(physical_dip_readings.reading_time) for the selected date.
 * Query params: pump_id, entry_date (YYYY-MM-DD)
 * Returns: { hasDipReadings: boolean, daily_entry_id: number | null }
 */
exports.checkTodayDipReadings = async (req, res) => {

  let connection;
  try {
    connection = await db.getConnection();
    const pumpId = req.query.pump_id;
    const entryDate = req.query.entry_date;
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }

    const [[entryRow]] = await connection.execute(
      `SELECT id
       FROM daily_sales_entries
       WHERE pump_id = ?
         AND entry_date = ?
         AND Active = 1
       ORDER BY id DESC
       LIMIT 1`,
      [pumpId, entryDate]
    );

    const dailyEntryId = entryRow?.id || null;

    const [[dipStats]] = await connection.execute(
      `SELECT COUNT(*) AS dip_count
       FROM physical_dip_readings pdr
       INNER JOIN fuel_tanks ft ON ft.id = pdr.tank_id AND ft.Active = 1
       WHERE ft.pump_id = ?
         AND DATE(pdr.reading_time) = ?
         AND pdr.Active = 1`,
      [pumpId, entryDate]
    );

    const openingSaved = Number(dipStats?.dip_count || 0) > 0;
    const closingSaved = false;

    return res.json({
      hasDipReadings: openingSaved,
      daily_entry_id: dailyEntryId,
      opening_saved: openingSaved,
      closing_saved: closingSaved,
      mode: openingSaved ? 'closing' : 'opening'
    });
  } catch (err) {
    console.error('Error checking dip readings:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Save dip readings for tanks into physical_dip_readings.
 * Rule: one active row per tank per date; if exists, update instead of insert.
 * Also creates/finds the daily_sales_entries record for that pump+date for response compatibility.
 * Body: { pump_id, entry_date (YYYY-MM-DD), shift, readings: [{tank_id, dip_mm, volume_liters}], CB, MB }
 * Returns: { success: true, daily_entry_id, message, updated_existing_count, inserted_count }
 */
exports.saveDipReadings = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const body = req.body || {};
    const pumpId = body.pump_id;
    const entryDate = body.entry_date;
    const readings = body.readings || [];
    const readingType = String(body.reading_type || 'opening').toLowerCase() === 'closing' ? 'closing' : 'opening';
    const cb = (body.CB && String(body.CB).trim()) ? String(body.CB).trim()
      : (body.username && String(body.username).trim()) ? String(body.username).trim()
        : 'System';
    const mb = (body.MB && String(body.MB).trim()) ? String(body.MB).trim()
      : cb;

    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }
    if (!readings || readings.length === 0) {
      return res.status(400).json({ message: 'No readings provided' });
    }

    await connection.beginTransaction();

    // 1. Insert or get daily_sales_entries
    await connection.execute(
      `INSERT INTO daily_sales_entries (pump_id, entry_date, status, submitted_at, CB, MB, cd, md, Active)
       VALUES (?, ?, 'submitted', NOW(), ?, ?, NOW(), NOW(), 1)
       ON DUPLICATE KEY UPDATE
         status = 'submitted',
         MB = VALUES(MB),
         md = NOW()`,
      [pumpId, entryDate, cb, mb]
    );

    const [[entryRow]] = await connection.execute(
      `SELECT id FROM daily_sales_entries WHERE pump_id = ? AND entry_date = ? LIMIT 1`,
      [pumpId, entryDate]
    );
    if (!entryRow || !entryRow.id) {
      throw new Error('Failed to create or find daily_sales_entries record');
    }
    const dailyEntryId = entryRow.id;

    // 2. Upsert each tank reading by (tank_id + entry_date) in physical_dip_readings only.
    let primaryKeyFixed = false;
    let updatedExistingCount = 0;
    let insertedCount = 0;
    for (const r of readings) {
      const [[existingDipRow]] = await connection.execute(
        `SELECT id
         FROM physical_dip_readings
         WHERE tank_id = ?
           AND DATE(reading_time) = ?
           AND Active = 1
         ORDER BY id DESC
         LIMIT 1`,
        [r.tank_id, entryDate]
      );

      const readingTime = `${entryDate} ${new Date().toTimeString().slice(0, 8)}`;
      if (existingDipRow && existingDipRow.id) {
        await connection.execute(
          `UPDATE physical_dip_readings
           SET dip_level = ?,
               volume_liters = ?,
               reading_time = ?,
               MB = ?,
               MD = NOW()
           WHERE id = ?`,
          [
            r.dip_mm,
            r.volume_liters || 0,
            readingTime,
            mb,
            existingDipRow.id
          ]
        );
        updatedExistingCount += 1;
      } else {
        try {
          await connection.execute(
            `INSERT INTO physical_dip_readings
               (tank_id, dip_level, volume_liters, reading_time, Active, CB, MB, CD, MD)
             VALUES (?, ?, ?, ?, 1, ?, ?, NOW(), NOW())`,
            [
              r.tank_id,
              r.dip_mm,
              r.volume_liters || 0,
              readingTime,
              cb,
              mb
            ]
          );
        } catch (insertErr) {
          const isPrimaryZeroDuplicate = insertErr &&
            insertErr.code === 'ER_DUP_ENTRY' &&
            insertErr.sqlMessage &&
            insertErr.sqlMessage.includes("Duplicate entry '0' for key 'PRIMARY'");

          if (!isPrimaryZeroDuplicate) {
            throw insertErr;
          }

          if (!primaryKeyFixed) {
            await connection.execute(
              `ALTER TABLE physical_dip_readings
               MODIFY COLUMN id INT NOT NULL AUTO_INCREMENT`
            );
            primaryKeyFixed = true;
          }

          await connection.execute(
            `INSERT INTO physical_dip_readings
               (tank_id, dip_level, volume_liters, reading_time, Active, CB, MB, CD, MD)
             VALUES (?, ?, ?, ?, 1, ?, ?, NOW(), NOW())`,
            [
              r.tank_id,
              r.dip_mm,
              r.volume_liters || 0,
              readingTime,
              cb,
              mb
            ]
          );
        }
        insertedCount += 1;
      }

    }

    await connection.commit();
    connection.release();

    return res.json({
      success: true,
      daily_entry_id: dailyEntryId,
      message: updatedExistingCount > 0
        ? `${readingType === 'opening' ? 'Opening' : 'Closing'} dip readings updated for existing tank/date (${updatedExistingCount}) and saved (${insertedCount} new).`
        : `${readingType === 'opening' ? 'Opening' : 'Closing'} dip readings saved successfully (${readings.length} tank${readings.length !== 1 ? 's' : ''})`,
      updated_existing_count: updatedExistingCount,
      inserted_count: insertedCount
    });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) { }
      connection.release();
    }
    console.error('Error saving dip readings:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

