const db = require('../models/db');

function resolveAuditUser(body) {
  const b = body || {};
  return b.MB || b.CB || b.userName || b.username || b.UserName || b.createdBy || b.modifiedBy || b.current_user || 'System';
}

async function getLatestCashManagementIdByDailyEntryId(executor, dailyEntryId) {
  const [rows] = await executor.execute(
    `SELECT id
     FROM cash_management
     WHERE daily_entry_id = ? AND Active = 1
     ORDER BY id DESC
     LIMIT 1`,
    [dailyEntryId]
  );

  if (!rows || rows.length === 0) {
    return null;
  }

  const id = Number(rows[0].id);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Normalize date string to YYYY-MM-DD format
 * Accepts: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, ISO string
 */
function normalizeDateFormat(dateString) {
  if (!dateString) return null;

  // If already in YYYY-MM-DD format, return as is
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return dateString;
  }

  // Try to parse ISO string or JavaScript Date
  const date = new Date(dateString);
  if (!isNaN(date.getTime())) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Try DD/MM/YYYY format
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateString)) {
    const [day, month, year] = dateString.split('/');
    return `${year}-${month}-${day}`;
  }

  // Try DD-MM-YYYY format
  if (/^\d{2}-\d{2}-\d{4}$/.test(dateString)) {
    const [day, month, year] = dateString.split('-');
    return `${year}-${month}-${day}`;
  }

  // Return as is if format is unrecognized
  return dateString;
}

function normalizeTankFuelKey(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return 'unknown';
  if (key.includes('petrol') || key === 'pmg' || key === 'ms') return 'petrol';
  if (key.includes('diesel') || key === 'hsd') return 'diesel';
  if (key.includes('mobile') || key.includes('lube')) return 'mobileOil';
  return 'unknown';
}

function getTankBaseLevel(row) {
  const hasClosing = row.closing_level !== null && row.closing_level !== undefined;
  const hasOpening = row.opening_level !== null && row.opening_level !== undefined;
  const received = Number(row.received_quantity || 0);

  if (hasClosing) {
    return Number(row.closing_level || 0) + received;
  }

  if (hasOpening) {
    return Number(row.opening_level || 0) + received;
  }

  // If no dip-based level exists, keep current tank level as the source of truth.
  return Number(row.current_level || 0);
}

async function syncTankInventoryAndStockForDailyEntry(connection, {
  dailyEntryId,
  pumpId,
  machines,
  allowUnallocatedTankStock,
  cb,
  mb
}) {


  const soldByFuel = { petrol: 0, diesel: 0, mobileOil: 0 };
  const tanksByFuel = { petrol: [], diesel: [], mobileOil: [] };
  const unallocatedByFuel = {};

  for (const machine of machines || []) {
    for (const nozzle of machine.nozzles || []) {
      const sold = Math.max(Number(nozzle?.digital?.sold || 0), Number(nozzle?.mechanical?.sold || 0));
      const fuelKey = normalizeTankFuelKey(nozzle.nozzle_type || nozzle.fuelType || machine.fuelType || 'Petrol');
      if (fuelKey === 'petrol') soldByFuel.petrol += sold;
      if (fuelKey === 'diesel') soldByFuel.diesel += sold;
      if (fuelKey === 'mobileOil') soldByFuel.mobileOil += sold;
    }
  }

  const [tankRows] = await connection.execute(
    `SELECT
        ft.id AS tank_id,
        ft.pump_id,
        ft.fuel_type,
        ft.current_level,
        ft.tank_number,
        dti.id AS inventory_id,
        dti.opening_level,
        dti.closing_level,
        dti.received_quantity,
        dti.purchase_reference
     FROM fuel_tanks ft
     LEFT JOIN daily_tank_inventory dti
       ON dti.daily_entry_id = ?
      AND dti.tank_id = ft.id
      AND dti.Active = 1
     WHERE ft.pump_id = ?
       AND ft.Active = 1
     ORDER BY ft.fuel_type, ft.tank_number, ft.id`,
    [dailyEntryId, pumpId]
  );

  for (const row of tankRows || []) {
    const fuelKey = normalizeTankFuelKey(row.fuel_type);
    if (fuelKey === 'petrol' || fuelKey === 'diesel' || fuelKey === 'mobileOil') {
      tanksByFuel[fuelKey].push(row);
    }
  }

  for (const fuelKey of Object.keys(tanksByFuel)) {
    const fuelTanks = tanksByFuel[fuelKey] || [];
    let remainingSold = Number(soldByFuel[fuelKey] || 0);
    let _fornextCurrentLevel = 0;// used to keep negative currrent level in case of insufficient stock and unallocated sold quantity for variance calculation
    for (const tank of fuelTanks) {
      // Requirement: opening snapshot must come from live fuel_tanks.current_level at submit time.
      const baseLevel = Math.max(0, Number(tank.current_level || 0));
      const soldQty = Math.min(baseLevel, remainingSold);
      remainingSold = Math.max(0, remainingSold - soldQty);
      const nextCurrentLevel = Math.max(0, baseLevel - soldQty);

      if (tank.inventory_id) {
        await connection.execute(
          `UPDATE daily_tank_inventory
           SET opening_level = ?,
               closing_level = ?,
               sold_quantity = ?,
               MB = ?,
               md = NOW()
           WHERE id = ?`,
          [baseLevel, nextCurrentLevel, soldQty, mb, tank.inventory_id]
        );
      } else {
        await connection.execute(
          `INSERT INTO daily_tank_inventory
             (daily_entry_id, tank_id, opening_level, closing_level, received_quantity, sold_quantity, purchase_reference, cd, md, CB, MB, Active)
           VALUES (?, ?, ?, ?, 0, ?, NULL, NOW(), NOW(), ?, ?, 1)`,
          [dailyEntryId, tank.tank_id, baseLevel, nextCurrentLevel, soldQty, cb, mb]
        );
      }

      await connection.execute(
        `UPDATE fuel_tanks
         SET current_level = ?,
             MB = ?,
             MD = NOW()
         WHERE id = ?
           AND pump_id = ?
           AND Active = 1`,
        [nextCurrentLevel, mb, tank.tank_id, pumpId]
      );
    }

    if (remainingSold > 0.0001) {
      const exceededQty = Number(remainingSold);
      unallocatedByFuel[fuelKey] = exceededQty;

      // Store exceeded sold quantity as negative variance on this fuel's last tank for the day.
      const varianceTank = fuelTanks.length > 0 ? fuelTanks[fuelTanks.length - 1] : null;
      if (varianceTank && varianceTank.tank_id) {
        await connection.execute(
          `UPDATE daily_tank_inventory
           SET stock_variance = COALESCE(stock_variance, 0) - ?,
               MB = ?,
               md = NOW()
           WHERE daily_entry_id = ?
             AND tank_id = ?
             AND Active = 1`,
          [exceededQty, mb, dailyEntryId, varianceTank.tank_id]
        );
        console.log('exceededQty' + exceededQty);
        await connection.execute(
          `UPDATE fuel_tanks
         SET current_level = ?,
             MB = ?,
             MD = NOW()
         WHERE id = ?
           AND pump_id = ?
           AND Active = 1`,
          [-exceededQty, mb, varianceTank.tank_id, pumpId]
        );
      }

      if (!allowUnallocatedTankStock) {
        throw new Error(`Insufficient ${fuelKey} tank stock for daily sales. Remaining unallocated sold quantity: ${remainingSold} L`);
      }
    }
  }

  // Apply tank returns after sold stock deduction.
  // Requirement: add tank return liters into fuel_tanks.current_level and keep daily_tank_inventory.closing_level aligned.
  const [tankReturnRows] = await connection.execute(
    `SELECT fuel_tank_id AS tank_id, COALESCE(SUM(liters_returned), 0) AS liters_returned
     FROM tank_returns
     WHERE daily_entry_id = ?
       AND Active = 1
       AND fuel_tank_id IS NOT NULL
     GROUP BY fuel_tank_id`,
    [dailyEntryId]
  );

  for (const row of (tankReturnRows || [])) {
    const tankId = Number(row.tank_id || 0);
    const litersReturned = Number(row.liters_returned || 0);
    if (!tankId || !(litersReturned > 0)) continue;

    const [tankCurrentRows] = await connection.execute(
      `SELECT id, pump_id, current_level
       FROM fuel_tanks
       WHERE id = ? AND pump_id = ? AND Active = 1
       LIMIT 1 FOR UPDATE`,
      [tankId, pumpId]
    );

    if (!tankCurrentRows || tankCurrentRows.length === 0) {
      continue;
    }

    const tankCurrent = tankCurrentRows[0];
    const levelBeforeReturn = Math.max(0, Number(tankCurrent.current_level || 0));
    const levelAfterReturn = levelBeforeReturn + litersReturned;

    await connection.execute(
      `UPDATE fuel_tanks
       SET current_level = ?, MB = ?, MD = NOW()
       WHERE id = ? AND pump_id = ? AND Active = 1`,
      [levelAfterReturn, mb, tankId, pumpId]
    );

    const [inventoryRows] = await connection.execute(
      `SELECT id
       FROM daily_tank_inventory
       WHERE daily_entry_id = ? AND tank_id = ? AND Active = 1
       LIMIT 1`,
      [dailyEntryId, tankId]
    );

    if (inventoryRows && inventoryRows.length > 0) {
      await connection.execute(
        `UPDATE daily_tank_inventory
         SET closing_level = ?,
             MB = ?,
             md = NOW()
         WHERE id = ?`,
        [levelAfterReturn, mb, inventoryRows[0].id]
      );
    } else {
      await connection.execute(
        `INSERT INTO daily_tank_inventory
           (daily_entry_id, tank_id, opening_level, closing_level, received_quantity, sold_quantity, purchase_reference, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, 0, 0, NULL, NOW(), NOW(), ?, ?, 1)`,
        [dailyEntryId, tankId, levelBeforeReturn, levelAfterReturn, cb, mb]
      );
    }
  }

  return { unallocatedByFuel };
}

function getRateFromFuelTypeAndPayloadRates(fuelType, rates) {
  const key = normalizeTankFuelKey(fuelType);
  const payloadRates = rates || {};
  if (key === 'petrol') return Number(payloadRates.petrol || 0) || 0;
  if (key === 'diesel') return Number(payloadRates.diesel || 0) || 0;
  if (key === 'mobileOil') return Number(payloadRates.mobileOil || 0) || 0;
  return 0;
}

function normalizeRecoveryPaymentMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'cash_in_hand';

  if (raw === 'cash_in_hand' || raw === 'cash') return 'cash_in_hand';
  if (raw === 'bank_account' || raw === 'bank') return 'bank_account';
  if (raw === 'account') return 'account';
  if (raw === 'depo') return 'depo';

  if (raw.includes('cash')) return 'cash_in_hand';
  if (raw.includes('bank')) return 'bank_account';
  if (raw.includes('depo')) return 'depo';
  if (raw.includes('account')) return 'account';

  return 'cash_in_hand';
}

/**
 * Get latest closing_digital_reading and closing_mechanical_reading from nozzle_readings
 * for each nozzle of a pump (from the most recent daily entry before entry_date).
 * Used to pre-fill Opening fields in Step 2 (Meter Readings).
 * Query params: pump_id, entry_date (YYYY-MM-DD).
 */
exports.getLatestNozzleReadings = async (req, res) => {

  let connection;

  try {

    connection = await db.getConnection();
    const pumpId = req.query.pump_id;
    const entryDate = req.query.entry_date; // YYYY-MM-DD
    if (!pumpId || !entryDate) {

      if (connection) connection.release();
      return res.status(400).json({ message: 'pump_id and entry_date are required' });

    }


    const [latestEntry] = await connection.execute(
      `SELECT dse.id
       FROM daily_sales_entries dse
       WHERE dse.pump_id = ? AND DATE(dse.entry_date) <= DATE(?) AND dse.Active = 1
       ORDER BY dse.entry_date DESC, dse.id DESC
       LIMIT 1`,
      [pumpId, entryDate]
    );


    if (!latestEntry || latestEntry.length === 0) {
      if (connection) connection.release();
      return res.status(200).json({ readings: [] });

    }

    const dailyEntryId = latestEntry[0].id;


    const [rows] = await connection.execute(
      `SELECT nozzle_id, closing_digital_reading, closing_mechanical_reading
       FROM nozzle_readings
       WHERE daily_entry_id = ? AND Active = 1`,
      [dailyEntryId]
    );

    // Get current readings from nozzles table for all relevant nozzles
    const nozzleIds = rows.map(r => r.nozzle_id).filter(id => id != null);
    let currentReadingsMap = new Map();

    if (nozzleIds.length > 0) {
      const placeholders = nozzleIds.map(() => '?').join(',');


      const [nozzles] = await connection.execute(
        `SELECT id, current_reading_digital, current_reading_mechanical 
         FROM nozzles 
         WHERE id IN (${placeholders}) AND Active = 1`,
        nozzleIds
      );

      nozzles.forEach(nozzle => {
        currentReadingsMap.set(nozzle.id, {
          digital: nozzle.current_reading_digital,
          mechanical: nozzle.current_reading_mechanical
        });
      });
    }



    const readings = (rows || []).map((r) => {
      let closingDigital = r.closing_digital_reading != null ? Number(r.closing_digital_reading) : null;
      let closingMechanical = r.closing_mechanical_reading != null ? Number(r.closing_mechanical_reading) : null;

      // If both readings are 0, load current readings from nozzles table
      if (closingDigital === 0 && closingMechanical === 0) {
        const currentReadings = currentReadingsMap.get(r.nozzle_id);
        if (currentReadings) {
          closingDigital = currentReadings.digital != null ? Number(currentReadings.digital) : 0;
          closingMechanical = currentReadings.mechanical != null ? Number(currentReadings.mechanical) : 0;
        }
      }

      return {
        nozzle_id: r.nozzle_id,
        closing_digital_reading: closingDigital,
        closing_mechanical_reading: closingMechanical
      };
    });
    return res.status(200).json({ readings });
  } catch (err) {
    console.error('getLatestNozzleReadings error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }
  }

};
/* exports.getLatestNozzleReadings = async (req, res) => {
  try {
    const pumpId = req.query.pump_id;
    const entryDate = req.query.entry_date; // YYYY-MM-DD
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }

    const connection = await db.getConnection();
    const [latestEntry] = await connection.execute(
      `SELECT dse.id
       FROM daily_sales_entries dse
       WHERE dse.pump_id = ? AND dse.entry_date <= ? AND dse.Active = 1
       ORDER BY dse.entry_date DESC, dse.id DESC
       LIMIT 1`,
      [pumpId, entryDate]
    );
    connection.release();

    if (!latestEntry || latestEntry.length === 0) {
      return res.status(200).json({ readings: [] });
    }

    const dailyEntryId = latestEntry[0].id;
    //console.log('getLatestNozzleReadings dailyEntryId:', dailyEntryId);
    const conn2 = await db.getConnection();
    const [rows] = await conn2.execute(
      `SELECT nozzle_id, closing_digital_reading, closing_mechanical_reading
       FROM nozzle_readings
       WHERE daily_entry_id = ? AND Active = 1`,
      [dailyEntryId]
    );
    //console.log('getLatestNozzleReadings rows for dailyEntryId', dailyEntryId, ':', rows);
    conn2.release();

    const readings = (rows || []).map((r) => ({

      
      nozzle_id: r.nozzle_id,
      closing_digital_reading: r.closing_digital_reading != null ? Number(r.closing_digital_reading) : null,
      closing_mechanical_reading: r.closing_mechanical_reading != null ? Number(r.closing_mechanical_reading) : null
    }));


    return res.status(200).json({ readings });
  } catch (err) {
    console.error('getLatestNozzleReadings error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
}; */

/**
 * Check if today's date has any nozzle_readings for a pump (prevent duplicate daily entry).
 * Query params: pump_id, entry_date (YYYY-MM-DD).
 * Returns: { hasToday: boolean, dailyEntryId: number | null }
 */
exports.checkTodayNozzleReadings = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    const pumpId = req.query.pump_id;

    const entryDate = req.query.entry_date; // YYYY-MM-DD
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }



    // Step 1: find daily_sales_entry for this pump + date
    const [entryRows] = await connection.execute(
      `SELECT id FROM daily_sales_entries WHERE pump_id = ? AND entry_date = ? AND Active = 1 order by id desc LIMIT 1`,
      [pumpId, entryDate]
    );

    if (!entryRows || entryRows.length === 0) {

      return res.status(200).json({ hasToday: false, dailyEntryId: null });
    }

    const dailyEntryId = entryRows[0].id;

    // Step 2: check if nozzle_readings already exist for this daily_entry_id
    const [nozzleRows] = await connection.execute(
      `SELECT id FROM nozzle_readings WHERE daily_entry_id = ? LIMIT 1`,
      [dailyEntryId]
    );


    if (nozzleRows && nozzleRows.length > 0) {
      return res.status(200).json({ hasToday: true, dailyEntryId });
    } else {
      return res.status(200).json({ hasToday: false, dailyEntryId });
    }
  } catch (err) {
    console.error('checkTodayNozzleReadings error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }
  }

};

exports.getPumpAssignedStaff = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const pumpId = Number(req.query.pump_id || 0);
    if (!pumpId) {
      return res.status(400).json({ message: 'pump_id is required' });
    }

    const [rows] = await connection.execute(
      `SELECT DISTINCT
         s.id AS staffid,
         s.name,
         s.phone,
         s.designation,
         s.role
       FROM staff s
       LEFT JOIN pump_staff ps
         ON ps.staffid = s.id
         AND ps.Active = 1
       WHERE s.Active = 1
         AND (ps.pumpid = ? OR s.pump_id = ?)
       ORDER BY s.name`,
      [pumpId, pumpId]
    );

    return res.status(200).json(rows || []);
  } catch (err) {
    console.error('getPumpAssignedStaff error:', err);
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.status(200).json([]);
    }
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) connection.release();
  }
};

/**
 * Get previous cash values from cash_management for a pump (for Step 4 opening balance).
 * Query params: pump_id, entry_date (YYYY-MM-DD).
 */
// Previous stable version of getPreviousDayCash
exports.getPreviousDayCash = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    const pumpId = req.query.pump_id;
    if (!pumpId) {
      return res.status(400).json({ message: 'pump_id is required' });
    }


    // Load latest cash_management row for the selected pump.
    const [rows] = await connection.execute(
      `SELECT cm.final_cash_in_hand, cm.cash_from_previous_day, cm.cash_from_previous_night
       FROM cash_management cm
       INNER JOIN daily_sales_entries dse ON dse.id = cm.daily_entry_id
       WHERE dse.pump_id = ?
         AND dse.Active = 1
         AND (cm.Active = 1 OR cm.Active IS NULL)
       ORDER BY cm.id DESC
       LIMIT 1`,
      [pumpId]
    );


    let finalCash = 0;
    let previousDay = null;
    let previousNight = null;
    if (rows && rows.length > 0) {
      finalCash = rows[0].final_cash_in_hand != null ? Number(rows[0].final_cash_in_hand) : 0;
      previousDay = rows[0].cash_from_previous_day != null ? Number(rows[0].cash_from_previous_day) : null;
      previousNight = rows[0].cash_from_previous_night != null ? Number(rows[0].cash_from_previous_night) : null;
    }

    return res.status(200).json({
      final_cash_in_hand: finalCash,
      cash_from_previous_day: previousDay,
      cash_from_previous_night: previousNight
    });

  } catch (err) {
    console.error('getPreviousDayCash error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }
  }

};

/**
 * Submit daily sales entry - saves to:
 * daily_sales_entries, nozzle_readings, machine_readings, mobile_oil_cash_sales,
 * daily_expenses, cash_management, credit_sales, daily_tank_inventory
 */
exports.submitDailyEntry = async (req, res) => {
  let connection;
  try {

    const body = req.body || {};

    const pumpId = body.pump_id;
    const entryDate = body.entry_date; // YYYY-MM-DD
    console.log(entryDate);
    //console.error('submitDailyEntry error:', err);


    const allowUnallocatedTankStock = body.allow_unallocated_tank_stock === true
      || body.allow_unallocated_tank_stock === 1
      || String(body.allow_unallocated_tank_stock || '').toLowerCase() === 'true';
    // CB/MB = username from frontend only (no default)
    const cb = (body.CB != null && String(body.CB).trim() !== '') ? String(body.CB).trim()
      : (body.MB != null && String(body.MB).trim() !== '') ? String(body.MB).trim()
        : (body.username != null && String(body.username).trim() !== '') ? String(body.username).trim()
          : (body.userName != null && String(body.userName).trim() !== '') ? String(body.userName).trim()
            : '';
    const mb = (body.MB != null && String(body.MB).trim() !== '') ? String(body.MB).trim()
      : (body.CB != null && String(body.CB).trim() !== '') ? String(body.CB).trim()
        : (body.username != null && String(body.username).trim() !== '') ? String(body.username).trim()
          : (body.userName != null && String(body.userName).trim() !== '') ? String(body.userName).trim()
            : '';

    if (!cb || !mb) {

      return res.status(400).json({ message: 'Username is required for CB/MB. Please log in and try again.' });
    }
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }

    connection = await db.getConnection();
    let pumpName = '';
    const [pumpRows] = await connection.execute(
      `SELECT name FROM petrol_pumps WHERE id = ? LIMIT 1`,
      [pumpId]
    );
    pumpName = pumpRows && pumpRows[0] && pumpRows[0].name
      ? String(pumpRows[0].name).trim()
      : 'Unknown Pump';

    await connection.beginTransaction();

    // 1. Always insert a NEW daily_sales_entries row.
    // This enables multiple daily fuel sales entries for the same pump/date.
    const [entryResult] = await connection.execute(
      `INSERT INTO daily_sales_entries (pump_id, entry_date, status, submitted_at, CB, MB, cd, md, Active)
       VALUES (?, ?, 'submitted', NOW(), ?, ?, NOW(), NOW(), 1)`,
      [pumpId, entryDate, cb, mb]
    );

    const dailyEntryId = entryResult.insertId ? Number(entryResult.insertId) : null;
    if (!dailyEntryId) {
      throw new Error('Failed to create daily_sales_entries record');
    }

    // --- INSERT FUEL RATES using dynamic fuel_type lookup ---
    const rates = body.rates || {};

    // Map frontend keys to fuel type names in database
    const frontendKeyToFuelName = {
      petrol: 'PMG',
      diesel: 'HSD',
      mobileOil: 'Mobile Oil'
    };

    for (const [frontendKey, fuelName] of Object.entries(frontendKeyToFuelName)) {
      const rate = Number(rates[frontendKey] || 0);
      if (rate <= 0) continue;

      // Get fuel_type_id from fuel_types table
      const [[fuelTypeRow]] = await connection.execute(
        `SELECT id FROM fuel_types WHERE name = ? AND Active = 1 LIMIT 1`,
        [fuelName]
      );
      if (!fuelTypeRow) {
        console.warn(`Fuel type "${fuelName}" not found in fuel_types. Skipping rate insertion.`);
        continue;
      }

      const fuelTypeId = fuelTypeRow.id;

      await connection.execute(
        `INSERT INTO fuel_rates
            (daily_entry_id, fuel_type_id, rate_per_liter, effective_date, CB, CD, MB, MD, Active)
         VALUES (?, ?, ?, ?, ?, NOW(), ?, NOW(), 1)`,
        [dailyEntryId, fuelTypeId, rate, entryDate, cb, mb]
      );
    }
    // --- END FUEL RATES INSERT ---
    // 1b. Save selected daily entry staff linked from Step 1.
    const dailyEntryStaff = Array.isArray(body.daily_entry_staff) ? body.daily_entry_staff : [];
    for (const staffItem of dailyEntryStaff) {
      const staffId = Number(staffItem?.staffid || 0);
      const staffPumpId = Number(staffItem?.pumpid || pumpId || 0);
      if (!staffId || !staffPumpId) continue;

      await connection.execute(
        `INSERT INTO daily_sales_entry_staff (daily_entry_id, pumpid, staffid, CB, MB, CD, MD, Active)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
        [dailyEntryId, staffPumpId, staffId, cb, mb]
      );
    }

    // 2. Nozzle readings (one row per nozzle: use max of digital/mechanical sold)
    const machines = body.machines || [];
    const nozzleIds = [];
    for (const machine of machines) {
      for (const nozzle of machine.nozzles || []) {
        const id = Number(nozzle?.id || 0);
        if (id > 0) nozzleIds.push(id);
      }
    }

    const nozzleTankIdMap = new Map();
    if (nozzleIds.length > 0) {
      const uniqueNozzleIds = [...new Set(nozzleIds)];
      const placeholders = uniqueNozzleIds.map(() => '?').join(', ');
      const [nozzleRows] = await connection.execute(
        `SELECT id, tank_id FROM nozzles WHERE id IN (${placeholders})`,
        uniqueNozzleIds
      );
      for (const row of (nozzleRows || [])) {
        nozzleTankIdMap.set(Number(row.id), row.tank_id != null ? Number(row.tank_id) : null);
      }
    }

    for (const machine of machines) {
      const machineId = machine.id;

      for (const nozzle of machine.nozzles || []) {
        const nozzleFuelType = (nozzle.nozzle_type || machine.fuelType || 'Petrol');
        const ratePerLiter = nozzleFuelType === 'Petrol'
          ? (body.rates?.petrol || 0)
          : nozzleFuelType === 'Diesel'
            ? (body.rates?.diesel || 0)
            : (body.rates?.mobileOil || 0);
        const nozzleId = nozzle.id;
        const digital = nozzle.digital || {};
        const mechanical = nozzle.mechanical || {};
        const openingDigital = digital.opening ?? 0;
        let closingDigital = digital.closing ?? 0;
        const openingMechanical = mechanical.opening ?? 0;
        let closingMechanical = mechanical.closing ?? 0;
        const totalSold = Math.max(digital.sold || 0, mechanical.sold || 0);
        const tankReturnLiters = Math.max(0, Number(nozzle?.tank_return ?? nozzle?.digital?.tankReturn ?? 0) || 0);
        const tankReturnReason = (
          nozzle?.tank_return_reason ??
          nozzle?.tankReturnReason ??
          nozzle?.reason ??
          ''
        ).toString().trim() || null;
        const fuelTankId = nozzle?.tank_id != null
          ? Number(nozzle.tank_id)
          : (nozzleTankIdMap.get(Number(nozzleId)) ?? null);
        const salesAmount = totalSold * ratePerLiter;

        // If closingDigital is 0, use openingDigital
        if (closingDigital === 0 || closingDigital === undefined || closingDigital === null) {
          closingDigital = openingDigital;
        }

        // If closingMechanical is 0, use openingMechanical
        if (closingMechanical === 0 || closingMechanical === undefined || closingMechanical === null) {
          closingMechanical = openingMechanical;
        }

        // Tank return liters are stored separately in tank_returns and must not alter
        // nozzle_readings closing values.
        await connection.execute(
          `INSERT INTO nozzle_readings (daily_entry_id, nozzle_id, opening_digital_reading, closing_digital_reading, opening_mechanical_reading, closing_mechanical_reading, total_sold, sales_amount, cd, md, CB, MB, Active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
          [dailyEntryId, nozzleId, openingDigital, closingDigital, openingMechanical, closingMechanical, totalSold, salesAmount, cb, mb]
        );

        if (nozzleId && tankReturnLiters > 0) {
          await connection.execute(
            `INSERT INTO tank_returns (nozzle_id, fuel_tank_id, daily_entry_id, reason, liters_returned, recorded_at, CB, MB, CD, MD, Active)
             VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, NOW(), NOW(), 1)`,
            [nozzleId, fuelTankId, dailyEntryId, tankReturnReason, tankReturnLiters, cb, mb]
          );
        }

        // Update nozzle table: set current_reading_digital/mechanical to Step-2 closing so next entry opens with these
        if (nozzleId) {
          // Build update fields dynamically
          const updateFields = [];
          const updateValues = [];

          if (closingDigital !== null && closingDigital !== undefined && closingDigital > 0) {
            updateFields.push('current_reading_digital = ?');
            updateValues.push(closingDigital);
          }

          if (closingMechanical !== null && closingMechanical !== undefined && closingMechanical > 0) {
            updateFields.push('current_reading_mechanical = ?');
            updateValues.push(closingMechanical);
          }

          // Only proceed if there are fields to update
          if (updateFields.length > 0) {
            updateFields.push('MB = ?', 'MD = NOW()');
            updateValues.push(mb); // Add MB value

            const query = `UPDATE nozzles SET ${updateFields.join(', ')} WHERE id = ?`;
            updateValues.push(nozzleId); // Add nozzleId for WHERE clause

            await connection.execute(query, updateValues);
          }
        }

      }
    }

    // 3. Machine readings (per machine: total_digital_sales, total_mechanical_sales, total_sales)
    for (const machine of machines) {
      const machineId = machine.id;
      let totalDigital = 0;
      let totalMechanical = 0;
      for (const nozzle of machine.nozzles || []) {
        totalDigital += nozzle.digital?.sold || 0;
        totalMechanical += nozzle.mechanical?.sold || 0;
      }
      const totalSales = Math.max(totalDigital, totalMechanical);

      await connection.execute(
        `INSERT INTO machine_readings (daily_entry_id, machine_id, total_digital_sales, total_mechanical_sales, total_sales, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
        [dailyEntryId, machineId, totalDigital, totalMechanical, totalSales, cb, mb]
      );
    }

    // 4. Mobile oil cash sales (supports single record or multiple rows)
    const mobileOilRows = Array.isArray(body.mobile_oil_cash_sales)
      ? body.mobile_oil_cash_sales
      : (body.mobile_oil_cash_sales ? [body.mobile_oil_cash_sales] : []);
    for (const mobileOil of mobileOilRows) {
      const litersSold = Number(mobileOil?.liters_sold ?? 0) || 0;
      const ratePerLiter = Number(mobileOil?.rate_per_liter ?? body.rates?.mobileOil ?? 0) || 0;
      if (litersSold <= 0 && ratePerLiter <= 0) {
        continue;
      }

      // Always calculate on server to keep total_amount consistent with liters/rate.
      const totalAmount = litersSold * ratePerLiter;

      const rawContainerType = String(mobileOil?.container_type || '').trim().toLowerCase();
      const containerType = ['carton', 'can', 'drum', 'dew'].includes(rawContainerType) ? rawContainerType : null;
      const containerLiters = Number(mobileOil?.container_liters ?? 0) || null;
      const noOfContainers = Number(mobileOil?.no_of_containers ?? 0) || null;

      await connection.execute(
        `INSERT INTO mobile_oil_cash_sales
          (daily_entry_id, pump_id, liters_sold, rate_per_liter, total_amount, container_type, container_liters, no_of_containers, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
        [dailyEntryId, pumpId, litersSold, ratePerLiter, totalAmount, containerType, containerLiters, noOfContainers, cb, mb]
      );

      // Also record in mobile_oil_purchase for stock tracking
      if (pumpId && litersSold > 0) {
        await connection.execute(
          `INSERT INTO mobile_oil_purchase
            (pump_id, liters_purchased, rate_per_liter, total_amount, container_type, container_liters, no_of_containers, active, cd, md, cb, mb)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW(), ?, ?)`,
          [pumpId, litersSold, ratePerLiter, totalAmount, containerType, containerLiters, noOfContainers, cb, mb]
        );
      }
    }

    // Deduct total mobile oil cash sales from fuel_tanks
    if (mobileOilRows.length > 0 && pumpId) {
      const totalMobileOilLitersSold = mobileOilRows.reduce(
        (sum, mo) => sum + (Number(mo?.liters_sold ?? 0) || 0), 0
      );
      if (totalMobileOilLitersSold > 0) {
        const [mobileOilTanks] = await connection.execute(
          `SELECT id, current_level FROM fuel_tanks
           WHERE pump_id = ? AND Active = 1 AND LOWER(fuel_type) LIKE '%mobile%'
           ORDER BY id ASC LIMIT 1`,
          [pumpId]
        );
        if (mobileOilTanks && mobileOilTanks.length > 0) {
          const tank = mobileOilTanks[0];
          const newLevel = Math.max(0, Number(tank.current_level || 0) - totalMobileOilLitersSold);
          await connection.execute(
            `UPDATE fuel_tanks SET current_level = ?, MB = ?, MD = NOW() WHERE id = ? AND Active = 1`,
            [newLevel, mb, tank.id]
          );
        }
      }
    }

    // 5. Daily expenses (saved after cash_management so we can use cash_management_id)
    const expenses = Array.isArray(body.expenses) ? body.expenses : [];
    const expensesTotal = expenses.reduce((sum, exp) => {
      const amount = Number(exp?.amount || 0) || 0;
      return amount > 0 ? sum + amount : sum;
    }, 0);



    // 6. Shifts table (shift_date, shift_name, meter readings, totals, status, CB, MB, CD, MD, Active)
    let openingDigital = 0, closingDigital = 0, openingMechanical = 0, closingMechanical = 0, totalFuelSold = 0;
    for (const machine of machines) {
      for (const nozzle of machine.nozzles || []) {
        const d = nozzle.digital || {};
        const m = nozzle.mechanical || {};
        openingDigital += Number(d.opening ?? 0);
        closingDigital += Number(d.closing ?? 0);
        openingMechanical += Number(m.opening ?? 0);
        closingMechanical += Number(m.closing ?? 0);
        totalFuelSold += Math.max(d.sold ?? 0, m.sold ?? 0);
      }
    }
    const totalSalesAmount = Number(body.report?.totalSales ?? 0) || 0;
    const shiftName = (body.shift === 'Night') ? 'Night' : 'Morning'; // Day -> Morning
    const managerId = body.userid != null ? parseInt(body.userid, 10) : null;


    if (managerId == null || isNaN(managerId)) {
      await connection.rollback();

      //return res.status(400).json({ message: 'User ID (userid) is required for shift manager_id. Please log in and try again.' });
      throw new Error('User ID (userid) is required for shift manager_id. Please log in and try again.');
    }
    const [shiftResult] = await connection.execute(
      `INSERT INTO shifts (shift_date, shift_name, manager_id, opening_digital_meter_reading, closing_digital_meter_reading,
        opening_mechanical_meter_reading, closing_mechanical_meter_reading, total_fuel_sold_, total_sales_amount, status, CB, MB, CD, MD, Active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CLOSED', ?, ?, NOW(), NOW(), 1)`,
      [entryDate, shiftName, managerId, openingDigital, closingDigital, openingMechanical, closingMechanical, totalFuelSold, totalSalesAmount, cb, mb]
    );
    const shiftId = shiftResult.insertId;

    // 7. Cash management (daily_entry_id, shift_id, cash_from_previous_day, cash_from_previous_night, other_income, other_income_description, total_cash_in_hand, total_cash_outflow, final_cash_in_hand, cd, md, CB, MB, Active)
    const cash = body.cash_management || body.cash || {};
    const previousDay = Number(cash.previousDay ?? cash.cash_from_previous_day ?? 0) || 0;
    const previousNight = Number(cash.previousNight ?? cash.cash_from_previous_night ?? 0) || 0;
    const otherIncome = Number(cash.otherIncome ?? cash.other_income ?? 0) || 0;
    const recoveries = Array.isArray(body.recoveries) ? body.recoveries : [];
    const derivedCashFromRecovery = recoveries.reduce((sum, recovery) => {
      const isSupplierFuelStationRecovery = recovery?.ws_customer_id != null
        && String(recovery?.recovery_source || '').toLowerCase() === 'fuel_station';
      return isSupplierFuelStationRecovery ? sum + (Number(recovery?.amount || 0) || 0) : sum;
    }, 0);
    const cashFromRecovery = Number(cash.cashFromRecovery ?? cash.cash_from_recovery ?? derivedCashFromRecovery) || 0;
    const totalCashInHand = Number(body.total_cash_in_hand) || (previousDay + otherIncome + (body.report?.totalSales || 0) - (body.report?.totalExpenses || 0));
    const cashOutflowDigital = Number(cash.cashOutflow?.digital ?? cash.cash_outflow_digital ?? 0) || 0;
    const cashOutflowBank = Number(cash.cashOutflow?.bankDeposit ?? cash.cash_outflow_bank ?? 0) || 0;
    const legacyCashOutflowOwner = Number(cash.cashOutflow?.ownerWithdrawal ?? cash.cash_outflow_owner ?? 0) || 0;
    const legacyCashOutflowPumpAdvance = Number(cash.cashOutflow?.pumpAdvance ?? cash.cash_outflow_pump_advance ?? 0) || 0;
    const ownerWithdrawalEntries = Array.isArray(body.owner_withdrawals) && body.owner_withdrawals.length > 0
      ? body.owner_withdrawals
      : (() => {
        const legacyOwnerWithdrawal = body.owner_withdrawal || {};
        const legacyAmount = Number(legacyOwnerWithdrawal.amount ?? legacyCashOutflowOwner) || 0;
        if (legacyAmount <= 0 && !(legacyOwnerWithdrawal.personName || '').trim()) {
          return [];
        }
        return [{
          ...legacyOwnerWithdrawal,
          amount: legacyAmount
        }];
      })();
    const pumpAdvanceEntries = Array.isArray(body.pump_advance)
      ? body.pump_advance
        .map((entry) => ({
          pump_id: Number(entry?.pump_id || 0) || 0,
          amount: Number(entry?.amount || 0) || 0,
          reference_name: (entry?.reference_name || '').toString().trim(),
          purpose: (entry?.purpose || '').toString().trim()
        }))
        .filter((entry) => entry.pump_id > 0 && entry.amount > 0)
      : [];
    const cashOutflowPumpAdvance = pumpAdvanceEntries.reduce((sum, entry) => sum + (Number(entry?.amount || 0) || 0), 0)
      || legacyCashOutflowPumpAdvance;
    const staffAdvanceEntries = Array.isArray(body.staff_advances)
      ? body.staff_advances
        .map((entry) => ({
          ...entry,
          _type: String(entry?.type || '').toLowerCase() === 'credit' ? 'credit' : 'debit'
        }))
        .filter((entry) => Number(entry?.staff_id || 0) > 0 && Number(entry?.amount || 0) > 0)
      : [];
    const staffAdvanceDebitAmount = staffAdvanceEntries
      .filter((entry) => entry._type === 'debit')
      .reduce((sum, entry) => sum + (Number(entry?.amount || 0) || 0), 0);
    const cashOutflowStaffAdvance = Number(cash.cashOutflow?.staffAdvance ?? cash.cash_outflow_staff_advance ?? 0)
      || staffAdvanceDebitAmount;
    const cashOutflowOwner = ownerWithdrawalEntries.reduce((sum, entry) => sum + (Number(entry?.amount) || 0), 0) || legacyCashOutflowOwner;
    const totalCashOutflowBase = Number(body.total_cash_outflow) || (cashOutflowDigital + cashOutflowBank + cashOutflowOwner + cashOutflowPumpAdvance + cashOutflowStaffAdvance);
    const totalCashOutflow = totalCashOutflowBase + expensesTotal;
    const hasFinalCashInPayload = body.report?.finalCash != null && body.report?.finalCash !== '';
    let finalCashInHand = Number(body.report?.finalCash ?? 0) || 0;
    if (!hasFinalCashInPayload || !Number.isFinite(finalCashInHand)) {
      finalCashInHand = (Number(totalCashInHand) || 0) + cashFromRecovery - (Number(totalCashOutflow) || 0);
    }
    const otherIncomeDescription = (cash.otherIncomeDescription != null && String(cash.otherIncomeDescription).trim() !== '') ? String(cash.otherIncomeDescription).trim() : null;

    // Insert into cash_in_hand table (always create new row)

    if (cashOutflowDigital !== 0) {


      /* const [pumpRows] = await connection.execute(
        `SELECT name FROM petrol_pumps WHERE id = ? LIMIT 1`,
        [pumpId]
      );
      const pumpName = pumpRows && pumpRows[0] && pumpRows[0].name
        ? String(pumpRows[0].name).trim()
        : ''; */
      const purpose = pumpName
        ? `Cash Received from Pump:  ${pumpName}`
        : 'Cash Received from Pump';


      const [rows] = await connection.execute(`
        SELECT balance
        FROM cash_in_hand
        WHERE Active = 1
        ORDER BY entry_date DESC, id DESC
        LIMIT 1
      `);
      const currentBalance = rows.length > 0 ? parseFloat(rows[0].balance) : 0;
      const newBalance = currentBalance + cashOutflowDigital; // credit adds to balance

      const [cinhandInsert] = await connection.execute(
        `INSERT INTO cash_in_hand (
        debit,
        credit,
        balance,
        purpose,
        created_at,
        CB,
        MB
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [0, cashOutflowDigital, newBalance, purpose, entryDate, cb, mb]
      );
    }


    // 1. Get pump advance of this pump for the current date (not adjusted)
    const [pumpAdvanceRows] = await connection.execute(
      `     SELECT
            COALESCE(SUM(pa.amount), 0) AS total_advance
            FROM pump_advance pa
            INNER JOIN cash_management cm ON pa.cash_management_id = cm.id AND cm.Active = 1
            INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
            WHERE pa.pump_id = ?
          AND DATE(dse.entry_date) = ?
          AND pa.pump_advance_adjusted = 0
          AND pa.Active = 1`,
      [pumpId, entryDate]
    );

    console.log('before pumpadvance added in finalCashInHand ' + finalCashInHand);
    let totalPumpAdvance = 0;
    if (pumpAdvanceRows && pumpAdvanceRows.length > 0) {
      totalPumpAdvance = parseFloat(pumpAdvanceRows[0].total_advance) || 0;
      finalCashInHand += totalPumpAdvance;
      console.log('Pump Advance: ' + totalPumpAdvance);
      console.log('after added pump advance in finalCashInHand ' + finalCashInHand);
    }

    // 2. Update pump_advance to mark as adjusted (only for current date)
    if (totalPumpAdvance > 0) {
      await connection.execute(
        `UPDATE pump_advance pa
             INNER JOIN cash_management cm ON pa.cash_management_id = cm.id AND cm.Active = 1
            INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id AND dse.Active = 1
             SET pa.pump_advance_adjusted = 1, 
                 pa.MB = ?, 
                 pa.MD = NOW()
             WHERE pa.pump_id = ? 
               AND pa.pump_advance_adjusted = 0 
               AND pa.Active = 1
               AND DATE(dse.entry_date) = DATE(?)`,
        [mb, pumpId, entryDate]
      );
    }
    console.log('Pump Advance updated for pumpid : ' + pumpId + ' dated" ' + entryDate);

    const [cmInsert] = await connection.execute(
      `INSERT INTO cash_management (daily_entry_id, shift_id, cash_from_previous_day, cash_from_previous_night, other_income, cash_from_recovery, other_income_description, total_cash_in_hand, total_cash_outflow, final_cash_in_hand, cd, md, CB, MB, Active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
      [dailyEntryId, shiftId, previousDay, previousNight, otherIncome, cashFromRecovery, otherIncomeDescription, totalCashInHand, totalCashOutflow, finalCashInHand, cb, mb]
    );


    const cashManagementId = cmInsert.insertId;



    // 7.1 Daily expenses (cash_management_id, expense_category, amount, description)
    for (const exp of expenses) {
      const categoryId = Number(exp?.category_id || 0) || 0;
      const amount = Number(exp?.amount || 0) || 0;
      const description = (exp?.description != null && String(exp.description).trim() !== '')
        ? String(exp.description).trim()
        : null;
      if (!categoryId || amount <= 0) continue;

      await connection.execute(
        `INSERT INTO daily_expenses (cash_management_id, expense_category, amount, description, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
        [cashManagementId, categoryId, amount, description, cb, mb]
      );
    }

    // 6. Net Cash Withdrawls (saved after cash_management so we can use cash_management_id)
    const netCashWithdrawals = Array.isArray(body.net_cash_withdrawals) ? body.net_cash_withdrawals : [];
    const netCashWithdrawalTotal = netCashWithdrawals.reduce((sum, cnwd) => {
      const amount = Number(cnwd?.amount || 0) || 0;
      return amount > 0 ? sum + amount : sum;
    }, 0);

    // 7. Bank Withdrawls (saved after cash_management so we can use cash_management_id)
    const bankWithdrawls = Array.isArray(body.bank_withdrawals) ? body.bank_withdrawals : [];
    const bankWithdrawlsTotal = expenses.reduce((sum, bt) => {
      const amount = Number(bt?.amount || 0) || 0;
      return amount > 0 ? sum + amount : sum;
    }, 0);
    // ============================================
    // BATCH INSERT INTO CASH_OUTFLOW_NET
    // ============================================
    if (netCashWithdrawals && netCashWithdrawals.length > 0) {
      const values = [];
      const placeholders = [];

      for (const cnwd of netCashWithdrawals) {
        const amount = Number(cnwd?.amount || 0);
        if (amount <= 0) continue;

        const recipientName = (cnwd?.recipientName != null && String(cnwd.recipientName).trim() !== '')
          ? String(cnwd.recipientName).trim()
          : 'Owner';
        const recipientRole = (cnwd?.recipientRole != null && String(cnwd.recipientRole).trim() !== '')
          ? String(cnwd.recipientRole).trim()
          : 'Owner';
        const reason = (cnwd?.reason != null && String(cnwd.reason).trim() !== '')
          ? String(cnwd.reason).trim()
          : 'Transfer to Cash in Hand';
        const receiptNumber = (cnwd?.receiptReference != null && String(cnwd.receiptReference).trim() !== '')
          ? String(cnwd.receiptReference).trim()
          : 'Transfer to Cash in Hand';
        const approvedBy = cb;

        values.push(
          cashManagementId,
          amount,
          recipientName,
          recipientRole,
          reason,
          receiptNumber,
          approvedBy,
          cb,
          mb
        );
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)');
      }

      if (values.length > 0) {
        const query = `
            INSERT INTO cash_outflow_net 
            (cash_management_id, amount, recipient_name, recipient_role, reason, receipt_number, 
             approved_by, CB, MB, CD, MD, Active) 
            VALUES ${placeholders.join(', ')}
        `;
        await connection.execute(query, values);
        console.log(`✅ Inserted ${netCashWithdrawals.length} net cash withdrawal entries`);
      }
    }


    // ============================================
    // BATCH INSERT INTO BANK_WITHDRAWALS
    // ============================================
    if (bankWithdrawls && bankWithdrawls.length > 0) {
      const values = [];
      const placeholders = [];
      const transactionValues = [];
      const transactionPlaceholders = [];

      for (const banktransfer of bankWithdrawls) {
        const amount = Number(banktransfer?.amount || 0);
        if (amount <= 0) continue;

        const bankName = (banktransfer?.bankName != null && String(banktransfer.bankName).trim() !== '')
          ? String(banktransfer.bankName).trim()
          : '';

        const accountTitle = (banktransfer?.accountTitle != null && String(banktransfer.accountTitle).trim() !== '')
          ? String(banktransfer.accountTitle).trim()
          : '';

        const accountNumber = (banktransfer?.accountNumber != null && String(banktransfer.accountNumber).trim() !== '')
          ? String(banktransfer.accountNumber).trim()
          : '';

        const transactionType = (banktransfer?.transactionType != null && String(banktransfer.transactionType).trim() !== '')
          ? String(banktransfer.transactionType).trim()
          : 'Cash Deposit';

        const transactionRef = (banktransfer?.transactionReference != null && String(banktransfer.transactionReference).trim() !== '')
          ? String(banktransfer.transactionReference).trim()
          : '';

        const reason = (banktransfer?.reason != null && String(banktransfer.reason).trim() !== '')
          ? String(banktransfer.reason).trim()
          : 'Bank Transfer/Deposit from Daily Sales Entry';

        // Get account ID from the bank transfer
        const accountId = banktransfer?.accountId != null ? Number(banktransfer.accountId) : null;

        // 1. Insert into bank_withdrawals table
        values.push(
          cashManagementId,
          amount,
          bankName,
          accountTitle,
          accountNumber,
          transactionType,
          transactionRef,
          reason,
          cb,
          mb
        );
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)');

        // 2. Insert into transactions table (for each bank withdrawal)
        if (accountId && Number.isFinite(accountId)) {
          transactionValues.push(
            null, // trip_id
            null, // cash_in_hand_id
            transactionType,
            transactionRef || null,
            reason,
            0, // Debit (0 for credit transactions)
            amount, // Credit
            accountId,
            entryDate,
            cb
          );
          transactionPlaceholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), 1)');
        }
      }

      // Execute bank_withdrawals insert
      if (values.length > 0) {
        const query = `
            INSERT INTO cash_outflow_bank
            (cash_management_id, amount, bank_name, account_title, account_number, 
             transaction_type, transaction_ref, reason, CB, MB, CD, MD, Active) 
            VALUES ${placeholders.join(', ')}
        `;
        await connection.execute(query, values);
        console.log(`✅ Inserted ${bankWithdrawls.length} bank withdrawal entries`);
      }

      // Execute transactions insert
      if (transactionValues.length > 0) {
        const transactionQuery = `
            INSERT INTO transactions
            (trip_id, cash_in_hand_id, PaymentMode, ReferenceNo, Purpose, Debit, Credit, AccountID, Date, CD, CB, MD, Active)
            VALUES ${transactionPlaceholders.join(', ')}
        `;
        await connection.execute(transactionQuery, transactionValues);
        console.log(`✅ Inserted ${bankWithdrawls.length} transaction entries for bank withdrawals`);

        // Update account balances (batch update)
        const accountMap = new Map();

        for (const withdrawal of bankWithdrawls) {
          if (withdrawal.accountId && withdrawal.amount && withdrawal.amount > 0) {
            const accountId = parseInt(withdrawal.accountId);
            const amount = parseFloat(withdrawal.amount);

            if (accountMap.has(accountId)) {
              // Add to existing total for this account
              accountMap.set(accountId, accountMap.get(accountId) + amount);
            } else {
              // New account
              accountMap.set(accountId, amount);
            }
          }
        }

        // Now update each account with the total amount
        let updatedCount = 0;
        for (const [accountId, totalAmount] of accountMap) {
          const updateQuery = `
        UPDATE accounts 
        SET Balance = Balance + ?, 
            MD = NOW() 
        WHERE ID = ?
    `;
          const [result] = await connection.execute(updateQuery, [totalAmount, accountId]);
          if (result.affectedRows > 0) {
            updatedCount++;
            console.log(`✅ Updated account ${accountId}: +${totalAmount}`);
          }
        }
        console.log(`✅ Updated ${updatedCount} account(s)`);

      }
    }



    // 8.1 Staff advances (stored as debit entries in staff_advance_salary)
    for (const advance of staffAdvanceEntries) {
      const staffId = Number(advance?.staff_id || 0) || 0;
      const amount = Number(advance?.amount || 0) || 0;
      const type = String(advance?._type || 'debit') === 'credit' ? 'credit' : 'debit';
      if (staffId <= 0 || amount <= 0) {
        continue;
      }

      await connection.execute(
        `INSERT INTO staff_advance_salary
          (staff_id, pump_id, cash_management_id, credit, debit, reason, CB, MB, cd, md, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
        [
          staffId,
          pumpId,
          cashManagementId,
          type === 'credit' ? amount : 0,
          type === 'debit' ? amount : 0,
          (advance?.reason || '').toString().trim().substring(0, 200) || 'Advance Salary',
          cb,
          mb
        ]
      );
    }

    // 8.2 Cash outflow child tables (CB, MB, CD, MD on all)
    // Only insert if there's actual data (amount > 0 or recipient name provided)
    /* const netCash = body.net_cash_withdrawal || {};
    //OLD Code commented as batch insertion is provided above
    if (cashOutflowDigital > 0 || (netCash.recipientName && netCash.recipientName.trim())) {
      await connection.execute(
        `INSERT INTO cash_outflow_net (cash_management_id, amount, recipient_name, recipient_role, reason, receipt_number, approved_by, CB, MB, CD, MD, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
        [
          cashManagementId,
          cashOutflowDigital,
          (netCash.recipientName || '').trim() || 'N/A',
          (netCash.recipientRole || '').trim() || 'N/A',
          (netCash.reason || '').trim() || 'Transfer to Cash in Hand',
          (netCash.receiptReference || netCash.reiptReference || '').trim() || 'N/A',
          cb,
          cb,
          mb
        ]
      );
    } */

    /* const bankTransfer = body.bank_transfer || {};
    if (cashOutflowBank > 0 || (bankTransfer.bankName && bankTransfer.bankName.trim())) {
      const selectedAccountId = bankTransfer.accountId != null && bankTransfer.accountId !== ''
        ? Number(bankTransfer.accountId)
        : null;

      let bankNameForInsert = (bankTransfer.bankName || '').trim() || 'N/A';
      let accountTitleForInsert = (bankTransfer.accountTitle || '').trim() || null;
      let accountNumberForInsert = (bankTransfer.accountNumber || '').trim() || null;

      // Prefer authoritative account/bank names from DB when AccountID is provided from dropdown.
      if (selectedAccountId && Number.isFinite(selectedAccountId)) {
        const [[accountRow]] = await connection.execute(
          `SELECT a.AccountTitle, a.AccountNo, b.Name AS BankName
           FROM accounts a
           LEFT JOIN bank b ON b.ID = a.BankID
           WHERE a.ID = ?
           LIMIT 1`,
          [selectedAccountId]
        );

        if (accountRow) {
          bankNameForInsert = String(accountRow.BankName || bankNameForInsert).trim() || 'N/A';
          accountTitleForInsert = String(accountRow.AccountTitle || accountTitleForInsert || '').trim() || null;
          accountNumberForInsert = String(accountRow.AccountNo || accountNumberForInsert || '').trim() || null;
        }
      }

      await connection.execute(
        `INSERT INTO cash_outflow_bank (cash_management_id, amount, bank_name, account_title, account_number, transaction_type, transaction_ref, reason, CB, MB, CD, MD, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
        [
          cashManagementId,
          cashOutflowBank,
          bankNameForInsert,
          accountTitleForInsert,
          accountNumberForInsert,
          (bankTransfer.transactionType || 'Cash Deposit').trim(),
          (bankTransfer.transactionReference || '').trim() || null,
          (bankTransfer.reason || '').trim() || null,
          cb,
          mb
        ]
      );

      // Mirror bank outflow in transactions table for audit trail.
      // Keep trip_id and cash_in_hand_id NULL as requested.
      await connection.execute(
        `INSERT INTO transactions
          (trip_id, cash_in_hand_id, PaymentMode, ReferenceNo, Purpose, Debit, Credit, AccountID, Date, CD, CB, MD, Active)
         VALUES (NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW(), 1)`,
        [
          (bankTransfer.transactionType || 'Cash Deposit').trim(),
          (bankTransfer.transactionReference || '').trim() || null,
          (bankTransfer.reason || 'Bank Transfer/Deposit from Daily Sales Entry').trim(),
          0,
          cashOutflowBank,
          (selectedAccountId && Number.isFinite(selectedAccountId)) ? selectedAccountId : null,
          entryDate,
          cb
        ]
      );
    } */

    //console.log('ownerWithdrawals:', ownerWithdrawalEntries, 'cashOutflowOwner:', cashOutflowOwner);

    // Handle owner withdrawals (multiple entries supported)
    for (const ownerWithdrawal of ownerWithdrawalEntries) {
      const ownerWithdrawalAmount = Number(ownerWithdrawal?.amount || 0) || 0;
      if (ownerWithdrawalAmount <= 0 && !(ownerWithdrawal?.personName || '').trim()) {
        continue;
      }

      let personTypeRaw = String(ownerWithdrawal.personType || '').trim();
      const personTypeKey = personTypeRaw.toLowerCase();
      const personId = ownerWithdrawal.personId != null ? Number(ownerWithdrawal.personId) : null;
      const personName = (ownerWithdrawal.personName || '').trim();

      //console.log('Processing owner withdrawal:', { ownerWithdrawalAmount, personTypeRaw, personTypeKey, personId, personName });
      // Insert into cash_outflow_owner

      if (personTypeRaw === 'Credit Customer') {
        console.log('Received personType "Credit Customer", normalizing to "Local" for database storage.');
        personTypeRaw = 'Local';
      }
      const [ownerOutflowResult] = await connection.execute(
        `INSERT INTO cash_outflow_owner 
      (cash_management_id, amount, person_type, person_name, person_id, purpose, notes, approved_by, CB, MB, CD, MD, Active)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NOW(), NOW(), 1)`,
        [
          cashManagementId,
          ownerWithdrawalAmount,
          personTypeRaw,
          personName || 'N/A',
          (personId && Number.isFinite(personId)) ? personId : null,
          (ownerWithdrawal.purpose || '').trim() || null,
          (ownerWithdrawal.notes || '').trim() || null,
          cb,
          mb
        ]
      );

    }

    let pumpadvanceamount = 0;
    for (const advanceEntry of pumpAdvanceEntries) {
      const advancePumpId = Number(advanceEntry.pump_id || 0) || 0;
      const advanceAmount = Number(advanceEntry.amount || 0) || 0;
      pumpadvanceamount += advanceAmount;
      if (!advancePumpId || !(advanceAmount > 0)) {
        continue;
      }

      await connection.execute(
        `INSERT INTO pump_advance
          (cash_management_id, amount, pump_id, reference_name, purpose, CB, MB, CD, MD, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
        [
          cashManagementId,
          advanceAmount,
          advancePumpId,
          advanceEntry.reference_name || null,
          advanceEntry.purpose || null,
          cb,
          mb
        ]
      );


    }

    // 9. Credit sales
    const creditSales = body.credit_sales || [];
    for (const cs of creditSales) {
      const customerId = cs.customer_id || null;
      const wsCustomerId = cs.ws_customer_id || null;
      const fuelType = cs.fuelType || 'Petrol';
      const quantityLiters = cs.quantity || 0;
      /*  const ratePerLiter = cs.priceType === 'Regular'
         ? (fuelType === 'Petrol' ? body.rates?.petrol : fuelType === 'Diesel' ? body.rates?.diesel : fuelType === 'Mobile Oil' ? body.rates?.mobileOil)
         : (cs.price || 0); */
      const ratePerLiter = cs.priceType === 'Regular'
        ? (fuelType === 'Petrol'
          ? body.rates?.petrol
          : fuelType === 'Diesel'
            ? body.rates?.diesel
            : fuelType === 'Mobile Oil'
              ? body.rates?.mobileOil
              : 0)
        : (cs.price || 0);
      const totalAmount = cs.total ?? quantityLiters * (ratePerLiter || 0);
      const priceType = cs.priceType || 'Regular';
      const specificPrice = cs.priceType === 'Specific' ? (cs.price || 0) : null;
      const notes = cs.notes || null;
      const customerVehicleId = customerId ? (cs.customer_vehicle_id || null) : null;

      // Track self-customer fuel movement in fuel_purchased ledger.

      let fuelPurchasedId = null;
      console.log(`Received quantity: ${cs.quantity} (type: ${typeof cs.quantity})`);
      if (wsCustomerId !== null && wsCustomerId !== undefined) {
        const [fuelResult] = await connection.execute(
          `INSERT INTO fuel_purchased
         (fuel_type, purchase_reference, liters_purchased, CB, MB, Active)
          VALUES (?, ?, ?, ?, ?, 1)`,
          [
            fuelType,
            'Transferred from ' + pumpName,
            quantityLiters,
            cb,
            mb
          ]
        );
        fuelPurchasedId = fuelResult.insertId;
      }

      await connection.execute(
        `INSERT INTO credit_sales (daily_entry_id, fuel_purchased_id, fuel_station_customer_id,
         ws_customer_id, customer_vehicle_id, fuel_type, quantity_liters, rate_per_liter,
          total_amount, price_type, specific_price, notes, payment_status, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW(), NOW(), ?, ?, 1)`,
        [dailyEntryId, fuelPurchasedId, customerId, wsCustomerId, customerVehicleId, fuelType,
          quantityLiters, ratePerLiter || 0, totalAmount, priceType, specificPrice, notes, cb, mb]
      );
    }

    // 9a. Recoveries (Supplier Trip Recovery): apply to trip payables using FIFO
    // NOTE: For Daily Sales Entry flow we do NOT create cash_in_hand rows because the amount
    // is already captured in cash_management.cash_from_recovery.
    const dailyRecoveries = Array.isArray(body.recoveries) ? body.recoveries : [];
    //console.log('dailyRecoveries:', dailyRecoveries);

    for (const recovery of dailyRecoveries) {
      const wsCustomerId = recovery?.ws_customer_id != null ? Number(recovery.ws_customer_id) : null;
      const CustomerId = recovery?.customer_id != null ? Number(recovery.customer_id) : null;
      const recoverySource = String(recovery?.recovery_source || '').toLowerCase();
      const amount = Number(recovery?.amount || 0) || 0;
      const isSupplierFuelStationRecovery = wsCustomerId != null && Number.isFinite(wsCustomerId) && recoverySource === 'fuel_station' && amount > 0;
      const isCustomerRecovery = CustomerId != null && Number.isFinite(CustomerId) && amount > 0;
      if (isCustomerRecovery) {
        const recoveryDate = recovery?.recovery_date ? normalizeDateFormat(recovery.recovery_date) : entryDate;
        const received_in = normalizeRecoveryPaymentMode(
          recovery?.payment_mode || recovery?.payment_method || recovery?.received_in
        );
        const recoveryReference = (recovery?.reference_no || recovery?.reference || '').toString().trim() || 'Recovery of Credit Fuels';
        await connection.execute(
          `INSERT INTO fuel_station_customer_recoveries
           (customer_id, ws_customer_id, station_id, transactionID, fuel_type, recovery_date, amount, payment_mode, reference, CB, MB, CD, MD, Active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
          [CustomerId, null, pumpId, null, null, recoveryDate, amount, received_in, recoveryReference, cb, mb]
        );
      }
      if (isSupplierFuelStationRecovery) {
        const recoveryDate = recovery?.recovery_date ? normalizeDateFormat(recovery.recovery_date) : entryDate;
        const paymentMode = normalizeRecoveryPaymentMode(
          recovery?.payment_mode || recovery?.payment_method || recovery?.received_in
        );
        const recoveryReference = (recovery?.reference_no || recovery?.reference || '').toString().trim() || 'Recovery of Credit Fuels';

        await connection.execute(
          `INSERT INTO fuel_station_customer_recoveries
             (customer_id, ws_customer_id, station_id, transactionID, fuel_type, recovery_date, amount, payment_mode, reference, CB, MB, CD, MD, Active)
           VALUES (NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
          [wsCustomerId, pumpId, recoveryDate, amount, paymentMode, recoveryReference, cb, mb]
        );
      }

      const isSupplierTripRecovery = wsCustomerId != null && Number.isFinite(wsCustomerId) && recoverySource === 'trip' && amount > 0;
      if (!isSupplierTripRecovery) {
        continue;
      }

      let remainingRecoveryAmount = amount;
      let tripIdForRecovery = null;

      const [tripsWithBalance] = await connection.execute(
        `SELECT t.id, t.amount_collected, t.total_amount,
                (COALESCE(t.total_amount, 0) - COALESCE(t.amount_collected, 0)) as remaining
         FROM trips t
         INNER JOIN pol_sale ps ON t.id = ps.trip_id AND ps.Active = 1
         WHERE ps.client_id = ?
           AND t.status != 'Cancelled'
           AND t.active = 1
           AND (COALESCE(t.total_amount, 0) - COALESCE(t.amount_collected, 0)) > 0
         ORDER BY t.start_date ASC, t.id ASC`,
        [wsCustomerId]
      );

      if (tripsWithBalance.length > 0) {
        tripIdForRecovery = Number(tripsWithBalance[0].id);
      }

      for (const trip of tripsWithBalance) {
        if (remainingRecoveryAmount <= 0) break;

        const totalAmount = Number(trip.total_amount || 0) || 0;
        const currentCollected = Number(trip.amount_collected || 0) || 0;
        const remaining = totalAmount - currentCollected;
        if (remaining <= 0) continue;

        const amountToApply = Math.min(remainingRecoveryAmount, remaining);
        const newCollected = currentCollected + amountToApply;

        await connection.execute(
          `UPDATE trips
           SET amount_collected = ?, MD = NOW()
           WHERE id = ?`,
          [newCollected, trip.id]
        );

        remainingRecoveryAmount -= amountToApply;
      }

      await connection.execute(
        `INSERT INTO recoveries (transactionID, ClientID, trip_id, Amount, Date, Payment_Head, Reference, CD, MD, Active)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, NOW(), 1)`,
        [
          wsCustomerId,
          tripIdForRecovery,
          amount,
          entryDate,
          'Cash in Hand',
          (recovery?.reference_no || recovery?.reference || '').toString().trim() || null,
          entryDate
        ]
      );
    }

    // 9b. Received quantity saved into daily_tank_inventory.

    const dailyTankInventoryRows = Array.isArray(body.daily_tank_inventory) ? body.daily_tank_inventory : [];

    const tankIds = [...new Set(dailyTankInventoryRows.map((row) => Number(row?.tank_id || 0)).filter((id) => id > 0))];
    const tankFuelMap = new Map();
    if (tankIds.length > 0) {
      const placeholders = tankIds.map(() => '?').join(', ');
      const [tankRows] = await connection.execute(
        `SELECT id, fuel_type FROM fuel_tanks WHERE id IN (${placeholders})`,
        tankIds
      );
      for (const tankRow of (tankRows || [])) {
        tankFuelMap.set(Number(tankRow.id), String(tankRow.fuel_type || ''));
      }
    }

    for (const row of dailyTankInventoryRows) {
      const tankId = Number(row?.tank_id || 0);
      const openingLevel = row?.opening_level != null ? Number(row.opening_level) : null;
      const closingLevel = row?.closing_level != null ? Number(row.closing_level) : null;
      const receivedQuantity = Number(row?.received_quantity || 0) || 0;
      const soldQuantity = Number(row?.sold_quantity || 0) || 0;
      const purchaseReference = row?.purchase_reference != null && String(row.purchase_reference).trim() !== ''
        ? String(row.purchase_reference).trim()
        : null;
      if (!tankId || (receivedQuantity <= 0 && soldQuantity <= 0 && openingLevel == null && closingLevel == null && !purchaseReference)) {
        continue;
      }

      const [existingInventoryRows] = await connection.execute(
        `SELECT id, received_quantity, purchase_reference
         FROM daily_tank_inventory
         WHERE daily_entry_id = ? AND tank_id = ? AND Active = 1
         LIMIT 1`,
        [dailyEntryId, tankId]
      );

      if (existingInventoryRows && existingInventoryRows.length > 0) {
        const existingRow = existingInventoryRows[0];
        const updatedReceivedQuantity = Number(existingRow.received_quantity || 0) + receivedQuantity;
        await connection.execute(
          `UPDATE daily_tank_inventory
           SET opening_level = COALESCE(?, opening_level),
               closing_level = COALESCE(?, closing_level),
               received_quantity = ?,
               sold_quantity = COALESCE(?, sold_quantity),
               purchase_reference = COALESCE(?, purchase_reference),
               MB = ?,
               md = NOW()
           WHERE id = ?`,
          [openingLevel, closingLevel, updatedReceivedQuantity, soldQuantity > 0 ? soldQuantity : null, purchaseReference, mb, existingRow.id]
        );
      } else {
        await connection.execute(
          `INSERT INTO daily_tank_inventory
             (daily_entry_id, tank_id, opening_level, closing_level, received_quantity, sold_quantity, purchase_reference, cd, md, CB, MB, Active)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
          [dailyEntryId, tankId, openingLevel, closingLevel, receivedQuantity, soldQuantity, purchaseReference, cb, mb]
        );
      }
    }

    // 10. Update tank sold quantities from machine/nozzle sales and recompute live tank stock.
    const tankSyncResult = await syncTankInventoryAndStockForDailyEntry(connection, {
      dailyEntryId,
      pumpId,
      machines,
      allowUnallocatedTankStock,
      cb,
      mb
    });

    await connection.commit();

    const unallocatedByFuel = tankSyncResult?.unallocatedByFuel || {};
    const hasUnallocated = Object.keys(unallocatedByFuel).length > 0;

    return res.status(200).json({
      message: 'Daily report submitted successfully',
      daily_entry_id: dailyEntryId,
      warning: hasUnallocated
        ? `Submitted with unallocated sold quantity: ${Object.entries(unallocatedByFuel).map(([fuel, qty]) => `${fuel} ${Number(qty).toFixed(2)} L`).join(', ')}`
        : undefined,
      unallocated_by_fuel: hasUnallocated ? unallocatedByFuel : undefined
    });
  } catch (err) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }
    const errMessage = err?.message || '';
    const isInsufficientTankStock = /Insufficient\s+[a-zA-Z]+\s+tank stock for daily sales\. Remaining unallocated sold quantity:/i.test(errMessage);
    if (isInsufficientTankStock) {
      return res.status(409).json({
        message: errMessage,
        code: 'INSUFFICIENT_TANK_STOCK'
      });
    }

    // Duplicate-key errors can come from tables other than daily_sales_entries.
    // Only report the friendly daily-entry message for the actual pump/date unique key.
    const duplicateSqlMessage = err.sqlMessage || '';
    const isDuplicate = err.code === 'ER_DUP_ENTRY' || (err.sqlState === '23000' && /Duplicate entry/.test(duplicateSqlMessage));
    const isDailyEntryDuplicate = isDuplicate && /unique_daily_entry|daily_sales_entries/i.test(duplicateSqlMessage);
    if (isDailyEntryDuplicate) {
      return res.status(409).json({
        message: 'A daily sales entry for this pump and date already exists. Please edit the existing entry or choose a different date.',
        code: 'DUPLICATE_ENTRY'
      });
    }
    if (isDuplicate) {
      return res.status(409).json({
        message: duplicateSqlMessage || 'A duplicate record conflict occurred while saving daily sales entry.',
        code: 'DUPLICATE_KEY'
      });
    }
    console.error('submitDailyEntry error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }
  }

};

/**
 * Get nozzle readings for a specific date from a pump
 * Query params: pump_id, entry_date (can be YYYY-MM-DD, DD/MM/YYYY, or ISO string)
 */
exports.getNozzleReadingsByDate = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    let pumpId = req.query.pump_id;
    let entryDate = req.query.entry_date; // Can be various formats
    const includeNoEntry = String(req.query.include_no_entry || '').trim() === '1'
      || String(req.query.include_no_entry || '').trim().toLowerCase() === 'true';
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }

    // Ensure pumpId is an integer
    pumpId = parseInt(pumpId, 10);

    // Normalize date format to YYYY-MM-DD
    entryDate = normalizeDateFormat(entryDate);
    console.log('getNozzleReadingsByDate - pumpId:', pumpId, 'entryDate (normalized):', entryDate);



    // In includeNoEntry mode (Daily Entry Step 2), always treat as NEW entry.
    // This allows multiple entries for the same date and ensures opening values come
    // from latest closing readings, not from an existing same-date entry's opening values.
    let dailyEntries = [];
    if (!includeNoEntry) {
      const [rows] = await connection.execute(
        `SELECT dse.id, dse.cd
         FROM daily_sales_entries dse
         WHERE dse.pump_id = ? AND CAST(dse.entry_date AS DATE) = CAST(? AS DATE) AND dse.Active = 1
         ORDER BY dse.id DESC
         LIMIT 1`,
        [pumpId, entryDate]
      );
      dailyEntries = rows || [];
    }

    if ((!dailyEntries || dailyEntries.length === 0) && !includeNoEntry) {

      return res.status(200).json({ machines: [], dailyEntryId: null, cdDateTime: null });
    }

    // Existing-entry mode: set dailyEntryId. New-entry mode: keep null.
    const dailyEntryId = (!includeNoEntry && dailyEntries && dailyEntries.length > 0) ? dailyEntries[0].id : null;
    const cdDateTime = (!includeNoEntry && dailyEntries && dailyEntries.length > 0) ? dailyEntries[0].cd : null;

    // Get all machines and their nozzles for this pump
    const [pumpsData] = await connection.execute(
      `SELECT
          m.id as machine_id,
          CONCAT('Machine ', m.machine_number) as machine_name,
          m.machine_number,
          n.id as nozzle_id,
          n.nozzle_number,
          n.nozzle_type,
          n.initial_reading_digital,
          n.current_reading_digital,
          n.initial_reading_mechanical,
          n.current_reading_mechanical
       FROM machines m
       INNER JOIN nozzles n ON m.id = n.machine_id
       WHERE m.pump_id = ? AND m.Active = 1 AND n.Active = 1
       ORDER BY m.id, n.id`,
      [pumpId]
    );
    //console.log('getNozzleReadingsByDate pumpsData:', pumpsData);
    if (!pumpsData || pumpsData.length === 0) {

      return res.status(200).json({ machines: [] });
    }

    // Get nozzle readings for this daily entry only if it exists
    let readings = [];
    if (dailyEntryId) {
      const [readingsData] = await connection.execute(
        `SELECT nozzle_id, opening_digital_reading, opening_mechanical_reading,
                closing_digital_reading, closing_mechanical_reading
         FROM nozzle_readings
         WHERE daily_entry_id = ? AND Active = 1`,
        [dailyEntryId]
      );
      readings = readingsData;
    }

    // For a new entry (no daily_sales_entries row for the selected date), load the most recent
    // previous entry's closing readings so they appear as the opening values in Step 2.
    let previousReadings = [];
    if (!dailyEntryId) {
      const [prevEntry] = await connection.execute(
        `SELECT dse.id
         FROM daily_sales_entries dse
         WHERE dse.pump_id = ? AND CAST(dse.entry_date AS DATE) <= CAST(? AS DATE) AND dse.Active = 1
         ORDER BY dse.entry_date DESC, dse.id DESC
         LIMIT 1`,
        [pumpId, entryDate]
      );
      if (prevEntry && prevEntry.length > 0) {
        const prevEntryId = prevEntry[0].id;
        const [prevRows] = await connection.execute(
          `SELECT nozzle_id, closing_digital_reading, closing_mechanical_reading
           FROM nozzle_readings
           WHERE daily_entry_id = ? AND Active = 1`,
          [prevEntryId]
        );
        previousReadings = prevRows || [];
        console.log('getNozzleReadingsByDate: No entry found for date', entryDate, 'Loading from previous entry', prevEntryId);
        console.log('getNozzleReadingsByDate: loaded', previousReadings.length, 'previous readings:', JSON.stringify(previousReadings.slice(0, 3)));
      } else {
        console.log('getNozzleReadingsByDate: No previous entry found before', entryDate);
      }
    }


    // Build hierarchical data structure
    const machinesMap = {};

    pumpsData.forEach(row => {
      if (!machinesMap[row.machine_id]) {
        machinesMap[row.machine_id] = {
          id: row.machine_id,
          name: row.machine_name,
          type: row.nozzle_type || null,
          nozzles: []
        };
      }

      // Find reading for this nozzle from nozzle_readings table (current day entry)
      const reading = readings.find(r => r.nozzle_id === row.nozzle_id);
      // Find previous entry's closing reading (used as opening for new entries)
      const prevReading = previousReadings.find(r => r.nozzle_id === row.nozzle_id);

      machinesMap[row.machine_id].nozzles.push({
        id: row.nozzle_id,
        name: `Nozzle ${row.nozzle_number}`,
        // Opening: from today's entry if exists, else from previous entry's closing, else from nozzle initial
        oldDigital: reading
          ? (reading.opening_digital_reading != null ? Number(reading.opening_digital_reading) : null)
          : prevReading
            ? (prevReading.closing_digital_reading != null ? Number(prevReading.closing_digital_reading) : (row.initial_reading_digital != null ? Number(row.initial_reading_digital) : null))
            : (row.initial_reading_digital != null ? Number(row.initial_reading_digital) : (row.current_reading_digital != null ? Number(row.current_reading_digital) : null)),
        newDigital: reading
          ? (reading.closing_digital_reading != null ? Number(reading.closing_digital_reading) : null)
          : null,
        oldMech: reading
          ? (reading.opening_mechanical_reading != null ? Number(reading.opening_mechanical_reading) : null)
          : prevReading
            ? (prevReading.closing_mechanical_reading != null ? Number(prevReading.closing_mechanical_reading) : (row.initial_reading_mechanical != null ? Number(row.initial_reading_mechanical) : null))
            : (row.initial_reading_mechanical != null ? Number(row.initial_reading_mechanical) : (row.current_reading_mechanical != null ? Number(row.current_reading_mechanical) : null)),
        newMech: reading
          ? (reading.closing_mechanical_reading != null ? Number(reading.closing_mechanical_reading) : null)
          : null,
        tankReturn: 0,
        actualSale: 0,
        isEditing: false
      });
    });

    const machines = Object.values(machinesMap);
    console.log('getNozzleReadingsByDate: returning', machines.length, 'machines for pump', pumpId, 'date', entryDate);
    machines.forEach((m, i) => {
      if (i < 2) console.log('  Machine', i, ':', m.name, 'with', m.nozzles.length, 'nozzles, first nozzle oldDigital:', m.nozzles[0]?.oldDigital);
    });
    return res.status(200).json({
      machines,
      dailyEntryId: dailyEntryId,
      cdDateTime: cdDateTime
    });
  } catch (err) {
    console.error('getNozzleReadingsByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }
  }

};

/**
 * Update nozzle readings for a daily entry
 */
exports.updateNozzleReadings = async (req, res) => {
  let connection;

  try {
    connection = await db.getConnection();
    const { daily_entry_id, readings } = req.body;
    const CreatedBy = resolveAuditUser(req.body);

    if (!daily_entry_id || !readings || !Array.isArray(readings)) {
      return res.status(400).json({ message: 'daily_entry_id and readings array are required' });
    }

    await connection.beginTransaction();

    // Update each nozzle reading
    for (const reading of readings) {
      const { nozzle_id, opening_digital_reading, closing_digital_reading,
        opening_mechanical_reading, closing_mechanical_reading } = reading;

      const digitalSold = Math.max(0, Number(closing_digital_reading || 0) - Number(opening_digital_reading || 0));
      const mechanicalSold = Math.max(0, Number(closing_mechanical_reading || 0) - Number(opening_mechanical_reading || 0));
      const totalSold = Math.max(digitalSold, mechanicalSold);

      // Check if reading exists
      const [existingReading] = await connection.execute(
        `SELECT id FROM nozzle_readings 
         WHERE daily_entry_id = ? AND nozzle_id = ? AND Active = 1`,
        [daily_entry_id, nozzle_id]
      );

      if (existingReading && existingReading.length > 0) {
        // Update existing reading
        await connection.execute(
          `UPDATE nozzle_readings 
           SET opening_digital_reading = ?, 
               closing_digital_reading = ?, 
               opening_mechanical_reading = ?, 
               closing_mechanical_reading = ?,
               total_sold = ?,
               mb = ?,
               md = NOW()
           WHERE id = ?`,
          [opening_digital_reading, closing_digital_reading,
            opening_mechanical_reading, closing_mechanical_reading,
            totalSold, CreatedBy, existingReading[0].id]
        );
      } else {
        // Insert new reading
        await connection.execute(
          `INSERT INTO nozzle_readings 
           (daily_entry_id, nozzle_id, opening_digital_reading, closing_digital_reading, 
            opening_mechanical_reading, closing_mechanical_reading, total_sold, cd, md, cb, mb, Active) 
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
          [daily_entry_id, nozzle_id, opening_digital_reading, closing_digital_reading,
            opening_mechanical_reading, closing_mechanical_reading, totalSold, CreatedBy, CreatedBy]
        );
      }
    }

    // Update the MD (modified date) of the daily sales entry
    await connection.execute(
      `UPDATE daily_sales_entries SET MB = ?, md = NOW() WHERE id = ?`,
      [CreatedBy, daily_entry_id]
    );

    await connection.commit();

    return res.status(200).json({ message: 'Nozzle readings updated successfully' });

  } catch (err) {

    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }

    console.error('updateNozzleReadings error:', err);
    return res.status(500).json({
      message: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });

  } finally {

    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr.message);
      }
    }
  }
};

// Get expenses by date
exports.getExpensesByDate = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    //console.log('getExpensesByDate: Start');
    const { date } = req.query;
    const pumpId = req.query.pumpId || req.body.pumpId || 1;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }

    console.log('getExpensesByDate: Looking for date', date, 'pumpId', pumpId);

    const normalizedDate = normalizeDateFormat(date);

    // First check if a daily sales entry exists for this date
    const [entries] = await connection.execute(
      `SELECT id, CD 
       FROM daily_sales_entries 
       WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 order by id desc
       LIMIT 1`,
      [pumpId, normalizedDate]
    );

    if (entries.length === 0) {
      //console.log('getExpensesByDate: No daily entry found for this date');
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        expenses: []
      });
    }

    const dailyEntryId = entries[0].id;
    const cdDateTime = entries[0].CD;

    console.log('getExpensesByDate: Daily entry found', dailyEntryId, 'CD:', cdDateTime);

    // Get expenses via cash_management mapping for this daily entry
    const [expenses] = await connection.execute(
      `SELECT 
        de.id,
        de.expense_category as categoryId,
        COALESCE(ec.name, 'Other') as categoryName,
        de.amount,
        de.description
       FROM daily_expenses de
       INNER JOIN cash_management cm ON cm.id = de.cash_management_id AND cm.Active = 1
       LEFT JOIN expense_categories ec ON de.expense_category = ec.id
       WHERE cm.daily_entry_id = ? AND de.Active = 1
       ORDER BY de.id ASC`,
      [dailyEntryId]
    );

    return res.status(200).json({
      dailyEntryId,
      cdDateTime,
      expenses: (expenses || []).map((expense) => ({
        id: expense.id,
        categoryId: expense.categoryId,
        categoryName: expense.categoryName,
        amount: expense.amount != null ? Number(expense.amount) : 0,
        description: expense.description || ''
      }))
    });
  } catch (err) {
    console.error('getExpensesByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Update expenses
exports.updateExpenses_old = async (req, res) => {

  let connection;
  try {
    connection = await db.getConnection();
    //console.log('updateExpenses: Start');
    const { daily_entry_id, expenses } = req.body;
    const updatedBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    if (!Array.isArray(expenses)) {
      return res.status(400).json({ message: 'Expenses must be an array' });
    }


    try {
      await connection.beginTransaction();

      //console.log('updateExpenses: Updating', expenses.length, 'expenses for daily entry', daily_entry_id);

      const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
      if (!cashManagementId) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ message: 'Cash management not found for the provided daily entry ID' });
      }

      // Update each expense
      for (const expense of expenses) {
        if (!expense.id) continue;

        await connection.execute(
          `UPDATE daily_expenses 
           SET amount = ?, 
               description = ?,
               MB = ?,
               MD = NOW()
           WHERE id = ? AND cash_management_id = ? AND Active = 1`,
          [
            expense.amount || 0,
            expense.description || null,
            updatedBy,
            expense.id,
            cashManagementId
          ]
        );
      }

      await connection.commit();
      connection.release();

      //console.log('updateExpenses: Successfully updated expenses');
      return res.status(200).json({ message: 'Expenses updated successfully' });

    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }

  } catch (err) {
    console.error('updateExpenses error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};
exports.updateExpenses = async (req, res) => {
  let connection;

  try {
    connection = await db.getConnection();
    const { daily_entry_id, expenses } = req.body;
    const updatedBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {
      //  Let finally handle release
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    if (!Array.isArray(expenses)) {
      //  Let finally handle release
      return res.status(400).json({ message: 'Expenses must be an array' });
    }

    await connection.beginTransaction();

    const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
    if (!cashManagementId) {
      //  Rollback and let finally handle release
      await connection.rollback();
      return res.status(404).json({ message: 'Cash management not found for the provided daily entry ID' });
    }

    // Update each expense
    for (const expense of expenses) {
      if (!expense.id) continue;

      await connection.execute(
        `UPDATE daily_expenses 
         SET amount = ?, 
             description = ?,
             MB = ?,
             MD = NOW()
         WHERE id = ? AND cash_management_id = ? AND Active = 1`,
        [
          expense.amount || 0,
          expense.description || null,
          updatedBy,
          expense.id,
          cashManagementId
        ]
      );
    }

    // Commit - NO manual release here
    await connection.commit();

    return res.status(200).json({ message: 'Expenses updated successfully' });

  } catch (err) {
    //  Rollback if transaction was started
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }

    console.error('updateExpenses error:', err);
    return res.status(500).json({
      message: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });

  } finally {
    // Single release point
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr.message);
      }
    }
  }
};
// Get expense categories
exports.getExpenseCategories = async (req, res) => {

  let connection;
  try {
    connection = await db.getConnection();
    //console.log('getExpenseCategories: Start');

    const includeAll = String(req.query.includeAll || '').toLowerCase();
    const shouldIncludeAll = includeAll === '1' || includeAll === 'true' || includeAll === 'yes';

    if (shouldIncludeAll) {
      const [allActiveCategories] = await connection.execute(
        `SELECT id, name, expense_type, created_at
         FROM expense_categories
         WHERE Active = 1
         ORDER BY name ASC`
      );

      return res.status(200).json(allActiveCategories);
    }

    // First try to get BUSINESS type categories
    const [categories] = await connection.execute(
      `SELECT id, name 
       FROM expense_categories 
       WHERE Active = 1 
       ORDER BY name ASC`
    );

    //console.log('getExpenseCategories: Found', categories.length, 'BUSINESS categories');

    // If no categories found, try to get all active categories as fallback
    if (categories.length === 0) {
      console.log('getExpenseCategories: No BUSINESS categories found, trying all active categories...');
      const [allCategories] = await connection.execute(
        `SELECT id, name 
         FROM expense_categories 
         WHERE Active = 1
         ORDER BY name ASC`
      );
      //console.log('getExpenseCategories: Found', allCategories.length, 'total active categories');

      return res.status(200).json({
        categories: allCategories.map(cat => ({
          id: cat.id,
          name: cat.name
        }))
      });
    }

    return res.status(200).json({
      categories: categories.map(cat => ({
        id: cat.id,
        name: cat.name
      }))
    });

  } catch (err) {
    console.error('getExpenseCategories error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } if (connection) {
    try {
      connection.release();
    } catch (releaseErr) {
      console.error('Error releasing connection:', releaseErr.message);
    }
  }
};

exports.saveExpenses = async (req, res) => {
  let connection;

  try {
    connection = await db.getConnection();
    const { daily_entry_id, existing_expenses, new_expenses } = req.body;
    const createdBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {

      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    await connection.beginTransaction();

    const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
    if (!cashManagementId) {
      // ✅ Rollback and let finally handle release
      await connection.rollback();
      return res.status(404).json({ message: 'Cash management not found for the provided daily entry ID' });
    }

    // Update existing expenses
    if (Array.isArray(existing_expenses) && existing_expenses.length > 0) {
      for (const expense of existing_expenses) {
        if (!expense.id) continue;

        await connection.execute(
          `UPDATE daily_expenses 
           SET amount = ?, 
               description = ?,
               MD = NOW(),
               MB = ?
           WHERE id = ? AND cash_management_id = ? AND Active = 1`,
          [
            expense.amount || 0,
            expense.description || null,
            createdBy,
            expense.id,
            cashManagementId
          ]
        );
      }
    }

    // Create new expenses
    if (Array.isArray(new_expenses) && new_expenses.length > 0) {
      for (const expense of new_expenses) {
        if (!expense.categoryId || expense.amount <= 0) continue;

        await connection.execute(
          `INSERT INTO daily_expenses 
           (cash_management_id, expense_category, amount, description, cd, md, CB, MB, Active)
           VALUES (?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
          [
            cashManagementId,
            expense.categoryId,
            expense.amount || 0,
            expense.description || null,
            createdBy,
            createdBy
          ]
        );
      }
    }

    // ✅ Commit - NO manual release here
    await connection.commit();

    return res.status(200).json({ message: 'Expenses saved successfully' });

  } catch (err) {
    // ✅ Rollback if transaction was started
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }

    console.error('saveExpenses error:', err);
    return res.status(500).json({
      message: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });

  } finally {
    // ✅ Single release point
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr.message);
      }
    }
  }
};
// Save expenses (update existing + create new)
/* exports.saveExpenses_old = async (req, res) => {

  let connection;
  try {
    connection = await db.getConnection();
    //console.log('saveExpenses: Start');
    const { daily_entry_id, existing_expenses, new_expenses } = req.body;
    const createdBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }



    try {
      await connection.beginTransaction();

      //console.log('saveExpenses: Updating', existing_expenses?.length || 0, 'existing expenses');
      //console.log('saveExpenses: Creating', new_expenses?.length || 0, 'new expenses');

      const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
      if (!cashManagementId) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ message: 'Cash management not found for the provided daily entry ID' });
      }

      // Update existing expenses
      if (Array.isArray(existing_expenses) && existing_expenses.length > 0) {
        for (const expense of existing_expenses) {
          if (!expense.id) continue;

          await connection.execute(
            `UPDATE daily_expenses 
             SET amount = ?, 
                 description = ?,
                 MD = NOW(),
                 MB = ?
             WHERE id = ? AND cash_management_id = ? AND Active = 1`,
            [
              expense.amount || 0,
              expense.description || null,
              createdBy,
              expense.id,
              cashManagementId
            ]
          );
        }
      }

      // Create new expenses
      if (Array.isArray(new_expenses) && new_expenses.length > 0) {
        for (const expense of new_expenses) {
          if (!expense.categoryId || expense.amount <= 0) continue;

          await connection.execute(
            `INSERT INTO daily_expenses 
             (cash_management_id, expense_category, amount, description, cd, md, CB, MB, Active)
             VALUES (?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
            [
              cashManagementId,
              expense.categoryId,
              expense.amount || 0,
              expense.description || null,
              createdBy,
              createdBy
            ]
          );
        }
      }

      await connection.commit();
      connection.release();

      //console.log('saveExpenses: Successfully saved all expenses');
      return res.status(200).json({ message: 'Expenses saved successfully' });

    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }

  } catch (err) {
    console.error('saveExpenses error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
}; */

// Get staff advances by date
exports.getStaffAdvancesByDate = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const { date } = req.query;
    const pumpId = req.query.pumpId || req.body.pumpId || 1;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }

    const normalizedDate = normalizeDateFormat(date);

    const [entries] = await connection.execute(
      `SELECT id, CD
       FROM daily_sales_entries
       WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 order by id desc
       LIMIT 1`,
      [pumpId, normalizedDate]
    );

    if (entries.length === 0) {
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        staffAdvances: []
      });
    }

    const dailyEntryId = entries[0].id;
    const cdDateTime = entries[0].CD;

    const [staffAdvances] = await connection.execute(
      `SELECT
         sas.id,
         sas.staff_id AS staffId,
         COALESCE(st.name, 'N/A') AS staffName,
         CASE WHEN COALESCE(sas.credit, 0) > 0 THEN 'credit' ELSE 'debit' END AS type,
         CASE WHEN COALESCE(sas.credit, 0) > 0 THEN COALESCE(sas.credit, 0) ELSE COALESCE(sas.debit, 0) END AS amount,
         sas.reason
       FROM staff_advance_salary sas
       INNER JOIN cash_management cm ON cm.id = sas.cash_management_id AND cm.Active = 1
       LEFT JOIN staff st ON st.id = sas.staff_id
       WHERE cm.daily_entry_id = ?
         AND sas.Active = 1
       ORDER BY sas.id ASC`,
      [dailyEntryId]
    );

    return res.status(200).json({
      dailyEntryId,
      cdDateTime,
      staffAdvances: (staffAdvances || []).map((row) => ({
        id: row.id,
        staffId: row.staffId,
        staffName: row.staffName || 'N/A',
        type: row.type === 'credit' ? 'credit' : 'debit',
        amount: row.amount != null ? Number(row.amount) : 0,
        reason: row.reason || ''
      }))
    });
  } catch (err) {
    console.error('getStaffAdvancesByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Save staff advances (update existing + create new)
/* exports.saveStaffAdvances_old = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    const { daily_entry_id, existing_advances, new_advances } = req.body;
    const createdBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }



    try {
      await connection.beginTransaction();

      const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
      if (!cashManagementId) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ message: 'Cash management not found for the provided daily entry ID' });
      }

      let pumpId = Number(req.body.pump_id || 0) || 0;
      if (!pumpId) {
        const [entryRows] = await connection.execute(
          `SELECT pump_id FROM daily_sales_entries WHERE id = ? LIMIT 1`,
          [daily_entry_id]
        );
        pumpId = entryRows && entryRows[0] ? Number(entryRows[0].pump_id || 0) || 0 : 0;
      }

      if (Array.isArray(existing_advances) && existing_advances.length > 0) {
        for (const advance of existing_advances) {
          if (!advance.id) continue;
          const amount = Number(advance.amount || 0) || 0;
          const type = String(advance.type || '').toLowerCase() === 'credit' ? 'credit' : 'debit';

          await connection.execute(
            `UPDATE staff_advance_salary
             SET credit = ?,
                 debit = ?,
                 reason = ?,
                 MD = NOW(),
                 MB = ?
             WHERE id = ? AND cash_management_id = ? AND Active = 1`,
            [
              type === 'credit' ? amount : 0,
              type === 'debit' ? amount : 0,
              (advance.reason || '').toString().trim().substring(0, 200) || null,
              createdBy,
              advance.id,
              cashManagementId
            ]
          );
        }
      }

      if (Array.isArray(new_advances) && new_advances.length > 0) {
        for (const advance of new_advances) {
          const staffId = Number(advance.staffId || advance.staff_id || 0) || 0;
          const amount = Number(advance.amount || 0) || 0;
          const type = String(advance.type || '').toLowerCase() === 'credit' ? 'credit' : 'debit';
          if (!staffId || amount <= 0) continue;

          await connection.execute(
            `INSERT INTO staff_advance_salary
              (staff_id, pump_id, cash_management_id, credit, debit, reason, CB, MB, cd, md, Active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
            [
              staffId,
              pumpId,
              cashManagementId,
              type === 'credit' ? amount : 0,
              type === 'debit' ? amount : 0,
              (advance.reason || '').toString().trim().substring(0, 200) || null,
              createdBy,
              createdBy
            ]
          );
        }
      }

      await connection.commit();
      connection.release();

      return res.status(200).json({ message: 'Staff advances saved successfully' });
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (err) {
    console.error('saveStaffAdvances error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
}; */

exports.saveStaffAdvances = async (req, res) => {
  let connection;

  try {
    connection = await db.getConnection();
    const { daily_entry_id, existing_advances, new_advances } = req.body;
    const createdBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {
      // ✅ Let finally handle release
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    await connection.beginTransaction();

    const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
    if (!cashManagementId) {
      // ✅ Rollback and let finally handle release
      await connection.rollback();
      return res.status(404).json({ message: 'Cash management not found for the provided daily entry ID' });
    }

    let pumpId = Number(req.body.pump_id || 0) || 0;
    if (!pumpId) {
      const [entryRows] = await connection.execute(
        `SELECT pump_id FROM daily_sales_entries WHERE id = ? LIMIT 1`,
        [daily_entry_id]
      );
      pumpId = entryRows && entryRows[0] ? Number(entryRows[0].pump_id || 0) || 0 : 0;
    }

    // Update existing advances
    if (Array.isArray(existing_advances) && existing_advances.length > 0) {
      for (const advance of existing_advances) {
        if (!advance.id) continue;
        const amount = Number(advance.amount || 0) || 0;
        const type = String(advance.type || '').toLowerCase() === 'credit' ? 'credit' : 'debit';

        await connection.execute(
          `UPDATE staff_advance_salary
           SET credit = ?,
               debit = ?,
               reason = ?,
               MD = NOW(),
               MB = ?
           WHERE id = ? AND cash_management_id = ? AND Active = 1`,
          [
            type === 'credit' ? amount : 0,
            type === 'debit' ? amount : 0,
            (advance.reason || '').toString().trim().substring(0, 200) || null,
            createdBy,
            advance.id,
            cashManagementId
          ]
        );
      }
    }

    // Create new advances
    if (Array.isArray(new_advances) && new_advances.length > 0) {
      for (const advance of new_advances) {
        const staffId = Number(advance.staffId || advance.staff_id || 0) || 0;
        const amount = Number(advance.amount || 0) || 0;
        const type = String(advance.type || '').toLowerCase() === 'credit' ? 'credit' : 'debit';
        if (!staffId || amount <= 0) continue;

        await connection.execute(
          `INSERT INTO staff_advance_salary
            (staff_id, pump_id, cash_management_id, credit, debit, reason, CB, MB, cd, md, Active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
          [
            staffId,
            pumpId,
            cashManagementId,
            type === 'credit' ? amount : 0,
            type === 'debit' ? amount : 0,
            (advance.reason || '').toString().trim().substring(0, 200) || null,
            createdBy,
            createdBy
          ]
        );
      }
    }

    // ✅ Commit - NO manual release here
    await connection.commit();

    return res.status(200).json({ message: 'Staff advances saved successfully' });

  } catch (err) {
    // ✅ Rollback if transaction was started
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }

    console.error('saveStaffAdvances error:', err);
    return res.status(500).json({
      message: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });

  } finally {
    // ✅ Single release point
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr.message);
      }
    }
  }
};
// Get pump advances by date
exports.getPumpAdvancesByDate = async (req, res) => {

  let connection;
  try {
    connection = await db.getConnection();
    const { date } = req.query;
    const pumpId = req.body.pumpId || 1;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }

    const normalizedDate = normalizeDateFormat(date);

    const [entries] = await connection.execute(
      `SELECT id, CD
       FROM daily_sales_entries
       WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 order by id desc
       LIMIT 1`,
      [pumpId, normalizedDate]
    );

    if (entries.length === 0) {
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        pumpAdvances: []
      });
    }

    const dailyEntryId = entries[0].id;
    const cdDateTime = entries[0].CD;

    const [pumpAdvances] = await connection.execute(
      `SELECT
         pa.id,
         pa.pump_id AS pumpId,
         COALESCE(p.name, 'N/A') AS pumpName,
         pa.amount,
         pa.reference_name AS referenceName,
         pa.purpose
       FROM pump_advance pa
       INNER JOIN cash_management cm ON cm.id = pa.cash_management_id AND cm.Active = 1
       LEFT JOIN petrol_pumps p ON p.id = pa.pump_id
       WHERE cm.daily_entry_id = ?
         AND pa.Active = 1
       ORDER BY pa.id ASC`,
      [dailyEntryId]
    );

    return res.status(200).json({
      dailyEntryId,
      cdDateTime,
      pumpAdvances: (pumpAdvances || []).map((row) => ({
        id: row.id,
        pumpId: row.pumpId,
        pumpName: row.pumpName || 'N/A',
        amount: row.amount != null ? Number(row.amount) : 0,
        referenceName: row.referenceName || '',
        purpose: row.purpose || ''
      }))
    });
  } catch (err) {
    console.error('getPumpAdvancesByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Save pump advances (update existing + create new)
/* exports.savePumpAdvances = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const { daily_entry_id, existing_advances, new_advances } = req.body;
    const createdBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }



    try {
      await connection.beginTransaction();

      const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
      if (!cashManagementId) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ message: 'Cash management not found for the provided daily entry ID' });
      }

      if (Array.isArray(existing_advances) && existing_advances.length > 0) {
        for (const advance of existing_advances) {
          if (!advance.id) continue;

          await connection.execute(
            `UPDATE pump_advance
             SET amount = ?,
                 reference_name = ?,
                 purpose = ?,
                 MD = NOW(),
                 MB = ?
             WHERE id = ? AND cash_management_id = ? AND Active = 1`,
            [
              Number(advance.amount || 0) || 0,
              (advance.referenceName || advance.reference_name || '').toString().trim() || null,
              (advance.purpose || '').toString().trim() || null,
              createdBy,
              advance.id,
              cashManagementId
            ]
          );
        }
      }

      if (Array.isArray(new_advances) && new_advances.length > 0) {
        for (const advance of new_advances) {
          const advancePumpId = Number(advance.pumpId || advance.pump_id || 0) || 0;
          const amount = Number(advance.amount || 0) || 0;
          if (!advancePumpId || amount <= 0) continue;

          await connection.execute(
            `INSERT INTO pump_advance
              (cash_management_id, amount, pump_id, reference_name, purpose, CB, MB, CD, MD, Active)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
            [
              cashManagementId,
              amount,
              advancePumpId,
              (advance.referenceName || advance.reference_name || '').toString().trim() || null,
              (advance.purpose || '').toString().trim() || null,
              createdBy,
              createdBy
            ]
          );
        }
      }

      await connection.commit();
      connection.release();

      return res.status(200).json({ message: 'Pump advances saved successfully' });
    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }
  } catch (err) {
    console.error('savePumpAdvances error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
}; */

exports.savePumpAdvances = async (req, res) => {
  let connection;

  try {
    connection = await db.getConnection();
    const { daily_entry_id, existing_advances, new_advances } = req.body;
    const createdBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {
      //  Let finally handle release
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    await connection.beginTransaction();

    const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
    if (!cashManagementId) {
      //  Rollback and let finally handle release
      await connection.rollback();
      return res.status(404).json({ message: 'Cash management not found for the provided daily entry ID' });
    }

    // Update existing advances
    if (Array.isArray(existing_advances) && existing_advances.length > 0) {
      for (const advance of existing_advances) {
        if (!advance.id) continue;

        await connection.execute(
          `UPDATE pump_advance
           SET amount = ?,
               reference_name = ?,
               purpose = ?,
               MD = NOW(),
               MB = ?
           WHERE id = ? AND cash_management_id = ? AND Active = 1`,
          [
            Number(advance.amount || 0) || 0,
            (advance.referenceName || advance.reference_name || '').toString().trim() || null,
            (advance.purpose || '').toString().trim() || null,
            createdBy,
            advance.id,
            cashManagementId
          ]
        );
      }
    }

    // Create new advances
    if (Array.isArray(new_advances) && new_advances.length > 0) {
      for (const advance of new_advances) {
        const advancePumpId = Number(advance.pumpId || advance.pump_id || 0) || 0;
        const amount = Number(advance.amount || 0) || 0;
        if (!advancePumpId || amount <= 0) continue;

        await connection.execute(
          `INSERT INTO pump_advance
            (cash_management_id, amount, pump_id, reference_name, purpose, CB, MB, CD, MD, Active)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
          [
            cashManagementId,
            amount,
            advancePumpId,
            (advance.referenceName || advance.reference_name || '').toString().trim() || null,
            (advance.purpose || '').toString().trim() || null,
            createdBy,
            createdBy
          ]
        );
      }
    }

    //  Commit - NO manual release here
    await connection.commit();

    return res.status(200).json({ message: 'Pump advances saved successfully' });

  } catch (err) {
    //  Rollback if transaction was started
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }

    console.error('savePumpAdvances error:', err);
    return res.status(500).json({
      message: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });

  } finally {
    // Single release point
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr.message);
      }
    }
  }
};

// Get credit sales by date
exports.getCreditSalesByDate = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    //console.log('getCreditSalesByDate: Start');
    const { pump_id, date } = req.query;

    if (!pump_id || !date) {
      return res.status(400).json({ message: 'Pump ID and date are required' });
    }

    const formattedDate = normalizeDateFormat(date);
    //console.log('getCreditSalesByDate: pump_id:', pump_id, 'date:', formattedDate);

    // First check if daily sales entry exists for this date
    const [dailyEntryRows] = await connection.execute(
      `SELECT id, CD as cdDateTime 
       FROM daily_sales_entries 
       WHERE pump_id = ? AND entry_date = ? AND Active = 1 
       ORDER BY id DESC
       LIMIT 1`,
      [pump_id, formattedDate]
    );

    if (dailyEntryRows.length === 0) {
      //console.log('getCreditSalesByDate: No daily entry found');
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        creditSales: []
      });
    }

    const dailyEntryId = dailyEntryRows[0].id;
    const cdDateTime = dailyEntryRows[0].cdDateTime;

    //console.log('getCreditSalesByDate: Found daily entry ID:', dailyEntryId, 'CD:', cdDateTime);

    // Get credit sales for this daily entry with customer, vehicle, and fuel type names
    const [creditSalesRows] = await connection.execute(
      `
    SELECT 
        cs.id,
        cs.fuel_station_customer_id as customerId,
        cs.ws_customer_id as ws_customer_id,
        COALESCE(
            fsc.customer_name, 
            wc.name, 
            pp.name, 
            'Unknown'
        ) as customerName,
        cs.customer_vehicle_id as customerVehicleId,
        fscv.vehicle_number as vehicleNumber,
        COALESCE(ft.id, cs.fuel_type) as fuelTypeId,
        cs.quantity_liters as quantity,
        cs.price_type as priceType,
        cs.rate_per_liter as ratePerLiter,
        cs.total_amount as totalAmount,
        cs.notes,
        CASE 
            WHEN cs.fuel_station_customer_id IS NOT NULL THEN 'Local'
            WHEN cs.ws_customer_id IS NOT NULL THEN 'Wholesale'
            ELSE 'Unknown'
        END as customerType,
        COALESCE(ft.name, cs.fuel_type) as fuelTypeName
    FROM credit_sales cs 
    -- For local customers
    LEFT JOIN fuel_station_customer fsc 
        ON cs.fuel_station_customer_id = fsc.customer_id 
        AND fsc.Active = 1
    
    -- For WS customers: Try customers table first
    LEFT JOIN customers wc 
        ON cs.ws_customer_id = wc.id 
        AND wc.active = 1
    
    -- For WS customers: Also try petrol_pumps table
    LEFT JOIN petrol_pumps pp 
        ON cs.ws_customer_id = pp.id 
        AND pp.Active = 1
    
    -- For vehicle details (local customers)
    LEFT JOIN fuele_station_customer_vehicles fscv 
        ON cs.customer_vehicle_id = fscv.vehicle_id 
        AND fscv.Active = 1
    
    -- For fuel type
    LEFT JOIN fuel_types ft 
        ON CAST(cs.fuel_type AS UNSIGNED) = ft.id 
        OR LOWER(ft.name) = LOWER(cs.fuel_type)
    
    WHERE cs.daily_entry_id = ? 
        AND cs.Active = 1
    ORDER BY cs.id
    `,
      [dailyEntryId]
    );
    /* 
    await db.execute(
      `SELECT 
        cs.id,
        cs.fuel_station_customer_id as customerId,
        cs.ws_customer_id as ws_customer_id,
        COALESCE(fsc.customer_name, wc.name) as customerName,
        cs.customer_vehicle_id as customerVehicleId,
        fscv.vehicle_number as vehicleNumber,
        COALESCE(ft.id, cs.fuel_type) as fuelTypeId,
        cs.quantity_liters as quantity,
        cs.price_type as priceType,
        cs.rate_per_liter as ratePerLiter,
        cs.total_amount as totalAmount,
        cs.notes,
        CASE WHEN cs.ws_customer_id IS NOT NULL THEN 'Supplier' ELSE 'Local' END as customerType,
        COALESCE(ft.name, cs.fuel_type) as fuelTypeName
       FROM credit_sales cs 
       LEFT JOIN fuel_station_customer fsc ON cs.fuel_station_customer_id = fsc.customer_id
       LEFT JOIN customers wc ON cs.ws_customer_id = wc.id
       LEFT JOIN fuele_station_customer_vehicles fscv ON cs.customer_vehicle_id = fscv.vehicle_id
       LEFT JOIN fuel_types ft ON CAST(cs.fuel_type AS UNSIGNED) = ft.id OR LOWER(ft.name) = LOWER(cs.fuel_type)
       WHERE cs.daily_entry_id = ? AND cs.Active = 1
       ORDER BY cs.id`,
      [dailyEntryId]
    ); */

    //console.log('getCreditSalesByDate: Found', creditSalesRows.length, 'credit sales');

    return res.status(200).json({
      dailyEntryId: dailyEntryId,
      cdDateTime: cdDateTime,
      creditSales: creditSalesRows
    });

  } catch (err) {
    console.error('getCreditSalesByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Save credit sales (update existing + create new)
exports.saveCreditSales_old = async (req, res) => {

  let connection;
  try {
    connection = await db.getConnection();
    //console.log('saveCreditSales: Start');
    const { daily_entry_id, existing_sales, new_sales } = req.body;
    const createdBy = resolveAuditUser(req.body);

    //console.log('saveCreditSales: Received new_sales:', JSON.stringify(new_sales, null, 2));

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    try {
      await connection.beginTransaction();

      console.log('saveCreditSales: Updating', existing_sales?.length || 0, 'existing sales');
      console.log('saveCreditSales: Creating', new_sales?.length || 0, 'new sales');

      // Update existing credit sales
      if (Array.isArray(existing_sales) && existing_sales.length > 0) {
        for (const sale of existing_sales) {
          if (!sale.id) continue;

          const fuelStationCustomerId = sale.customerId || null;
          const wsCustomerId = sale.ws_customer_id || null;
          const customerVehicleId = fuelStationCustomerId ? (sale.customerVehicleId || null) : null;
          /* 
                    console.log('saveCreditSales: Updating existing sale ID', sale.id,
                      'with:', { customerId: fuelStationCustomerId, wsCustomerId, vehicleId: customerVehicleId, fuelTypeId: sale.fuelTypeId }); */

          await connection.execute(
            `UPDATE credit_sales 
             SET fuel_station_customer_id = ?,
                 ws_customer_id = ?,
                 customer_vehicle_id = ?,
                 fuel_type = ?,
                 quantity_liters = ?, 
                 rate_per_liter = ?,
                 total_amount = ?,
                 price_type = ?,
                 notes = ?,
                 MD = NOW(),
                 MB = ?
             WHERE id = ? AND daily_entry_id = ? AND Active = 1`,
            [
              fuelStationCustomerId,
              wsCustomerId,
              customerVehicleId,
              sale.fuelTypeId || null,
              sale.quantity || 0,
              sale.ratePerLiter || 0,
              sale.totalAmount || 0,
              sale.priceType || 'Regular',
              sale.notes || null,
              createdBy,
              sale.id,
              daily_entry_id
            ]
          );
        }
      }

      // Create new credit sales
      if (Array.isArray(new_sales) && new_sales.length > 0) {
        for (const sale of new_sales) {
          const fuelStationCustomerId = sale.customerId || null;
          const wsCustomerId = sale.ws_customer_id || null;
          if ((!fuelStationCustomerId && !wsCustomerId) || !sale.fuelTypeId || sale.quantity <= 0) continue;

          const customerVehicleId = fuelStationCustomerId ? (sale.customerVehicleId || null) : null;

          /*  console.log('saveCreditSales: Inserting new sale:',
             { customerId: fuelStationCustomerId, wsCustomerId, vehicleId: customerVehicleId, fuelTypeId: sale.fuelTypeId, qty: sale.quantity }); */

          await connection.execute(
            `INSERT INTO credit_sales 
             (daily_entry_id, fuel_station_customer_id, ws_customer_id, customer_vehicle_id, fuel_type, quantity_liters, rate_per_liter, 
              total_amount, price_type, specific_price, notes, payment_status, paid_amount, 
              remaining_amount, cd, md, CB, MB, Active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NOW(), NOW(), ?, ?, 1)`,
            [
              daily_entry_id,
              fuelStationCustomerId,
              wsCustomerId,
              customerVehicleId,
              sale.fuelTypeId,
              sale.quantity || 0,
              sale.ratePerLiter || 0,
              sale.totalAmount || 0,
              sale.priceType || 'Regular',
              sale.priceType === 'Standard' ? (sale.ratePerLiter || 0) : null,
              sale.notes || null,
              sale.totalAmount || 0,
              createdBy,
              createdBy
            ]
          );
        }
      }

      await connection.commit();
      connection.release();

      //console.log('saveCreditSales: Successfully saved all credit sales');
      return res.status(200).json({ message: 'Credit sales saved successfully' });

    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }

  } catch (err) {
    console.error('saveCreditSales error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

exports.saveCreditSales = async (req, res) => {
  let connection;

  try {
    connection = await db.getConnection();
    const { daily_entry_id, existing_sales, new_sales } = req.body;
    const createdBy = resolveAuditUser(req.body);

    if (!daily_entry_id) {
      //  Let finally handle release
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    await connection.beginTransaction();

    console.log('saveCreditSales: Updating', existing_sales?.length || 0, 'existing sales');
    console.log('saveCreditSales: Creating', new_sales?.length || 0, 'new sales');

    // Update existing credit sales
    if (Array.isArray(existing_sales) && existing_sales.length > 0) {
      for (const sale of existing_sales) {
        if (!sale.id) continue;

        const fuelStationCustomerId = sale.customerId || null;
        const wsCustomerId = sale.ws_customer_id || null;
        const customerVehicleId = fuelStationCustomerId ? (sale.customerVehicleId || null) : null;

        await connection.execute(
          `UPDATE credit_sales 
           SET fuel_station_customer_id = ?,
               ws_customer_id = ?,
               customer_vehicle_id = ?,
               fuel_type = ?,
               quantity_liters = ?, 
               rate_per_liter = ?,
               total_amount = ?,
               price_type = ?,
               notes = ?,
               MD = NOW(),
               MB = ?
           WHERE id = ? AND daily_entry_id = ? AND Active = 1`,
          [
            fuelStationCustomerId,
            wsCustomerId,
            customerVehicleId,
            sale.fuelTypeId || null,
            sale.quantity || 0,
            sale.ratePerLiter || 0,
            sale.totalAmount || 0,
            sale.priceType || 'Regular',
            sale.notes || null,
            createdBy,
            sale.id,
            daily_entry_id
          ]
        );
      }
    }

    // Create new credit sales
    if (Array.isArray(new_sales) && new_sales.length > 0) {
      for (const sale of new_sales) {
        const fuelStationCustomerId = sale.customerId || null;
        const wsCustomerId = sale.ws_customer_id || null;
        if ((!fuelStationCustomerId && !wsCustomerId) || !sale.fuelTypeId || sale.quantity <= 0) continue;

        const customerVehicleId = fuelStationCustomerId ? (sale.customerVehicleId || null) : null;

        await connection.execute(
          `INSERT INTO credit_sales 
           (daily_entry_id, fuel_station_customer_id, ws_customer_id, customer_vehicle_id, fuel_type, quantity_liters, rate_per_liter, 
            total_amount, price_type, specific_price, notes, payment_status, paid_amount, 
            remaining_amount, cd, md, CB, MB, Active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NOW(), NOW(), ?, ?, 1)`,
          [
            daily_entry_id,
            fuelStationCustomerId,
            wsCustomerId,
            customerVehicleId,
            sale.fuelTypeId,
            sale.quantity || 0,
            sale.ratePerLiter || 0,
            sale.totalAmount || 0,
            sale.priceType || 'Regular',
            sale.priceType === 'Standard' ? (sale.ratePerLiter || 0) : null,
            sale.notes || null,
            sale.totalAmount || 0,
            createdBy,
            createdBy
          ]
        );
      }
    }

    //  Commit - NO manual release here
    await connection.commit();

    return res.status(200).json({ message: 'Credit sales saved successfully' });

  } catch (err) {
    //  Rollback if transaction was started
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }

    console.error('saveCreditSales error:', err);
    return res.status(500).json({
      message: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });

  } finally {
    //  Single release point
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr.message);
      }
    }
  }
};

// Get Other Income from cash_management table
exports.getOtherIncomeByDate = async (req, res) => {
  let connection;
  try {

    connection = await db.getConnection();
    //console.log('getOtherIncomeByDate: Start');
    const { date } = req.query;
    const pumpId = req.body.pumpId || 1;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }

    console.log('getOtherIncomeByDate: Looking for date', date, 'pumpId', pumpId);

    const normalizedDate = normalizeDateFormat(date);

    // First check if a daily sales entry exists for this date
    const [entries] = await connection.execute(
      `SELECT id, CD 
         FROM daily_sales_entries 
         WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 order by id desc
         LIMIT 1`,
      [pumpId, normalizedDate]
    );

    if (entries.length === 0) {
      console.log('getOtherIncomeByDate: No daily entry found for this date');
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        cashManagement: []
      });
    }

    const dailyEntryId = entries[0].id;
    const cdDateTime = entries[0].CD;

    //console.log('getOtherIncomeByDate: Daily entry found', dailyEntryId, 'CD:', cdDateTime);

    // Get other_income and other_income_description from cash_management for this daily entry
    const [cashMgmtRows] = await connection.execute(
      `SELECT 
          id,
          other_income,
          other_income_description
         FROM cash_management
         WHERE daily_entry_id = ? AND Active = 1
         LIMIT 1`,
      [dailyEntryId]
    );

    const cashManagement = (cashMgmtRows || []).map((row) => ({
      id: row.id,
      other_income: row.other_income != null ? Number(row.other_income) : 0,
      other_income_description: row.other_income_description || ''
    }));

    return res.status(200).json({
      dailyEntryId,
      cdDateTime,
      cashManagement: cashManagement
    });

  } catch (err) {
    console.error('getOtherIncomeByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) {
      connection.release();
    }
  }
};

// Update Other Income in cash_management table
exports.updateCashManagementOtherIncome = async (req, res) => {
  let connection;
  try {

    connection = await db.getConnection();
    //console.log('updateCashManagementOtherIncome: Start');
    const { daily_entry_id, other_income, other_income_description, current_user } = req.body;

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    //console.log('updateCashManagementOtherIncome: Updating other_income for daily_entry_id:', daily_entry_id);

    // Update the cash_management record's other_income fields
    const [result] = await connection.execute(
      `UPDATE cash_management 
         SET other_income = ?,
             other_income_description = ?,
             MD = NOW(),
             MB = ?
         WHERE daily_entry_id = ? AND Active = 1`,
      [
        other_income || 0,
        other_income_description || '',
        current_user || 'System',
        daily_entry_id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Cash management record not found for this daily entry' });
    }

    //console.log('updateCashManagementOtherIncome: Successfully updated');
    return res.status(200).json({ message: 'Other income updated successfully' });

  } catch (err) {
    console.error('updateCashManagementOtherIncome error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }

  }
};

// Get bank transfers for the selected pump date from cash_outflow_bank
exports.getBankTransfersByDate = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    //console.log('getBankTransfersByDate: Start');
    const { date } = req.query;
    const pumpId = req.query.pumpId || req.body.pumpId || 1;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }

    const normalizedDate = normalizeDateFormat(date);
    const [entries] = await connection.execute(
      `SELECT id, CD
         FROM daily_sales_entries
         WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 order by id desc
         LIMIT 1`,
      [pumpId, normalizedDate]
    );

    if (entries.length === 0) {
      console.log('getBankTransfersByDate: No daily entry found for this date');
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        bankTransfers: []
      });
    }

    const dailyEntryId = entries[0].id;
    const cdDateTime = entries[0].CD;

    const [cmRows] = await connection.execute(
      `SELECT id
         FROM cash_management
         WHERE daily_entry_id = ? AND Active = 1
         ORDER BY id DESC
         LIMIT 1`,
      [dailyEntryId]
    );

    if (!cmRows || cmRows.length === 0) {
      console.log('getBankTransfersByDate: No cash management record found');
      return res.status(200).json({
        dailyEntryId,
        cdDateTime,
        bankTransfers: []
      });
    }

    const cashManagementId = Number(cmRows[0].id);
    const [bankRows] = await connection.execute(
      `SELECT id,
              amount,
              bank_name AS bankName,
              account_title AS accountTitle,
              account_number AS accountNumber,
              transaction_type AS transactionType,
              transaction_ref AS transactionReference,
              reason
         FROM cash_outflow_bank
         WHERE cash_management_id = ? AND Active = 1
         ORDER BY id ASC`,
      [cashManagementId]
    );

    const bankTransfers = (bankRows || []).map((row) => ({
      id: Number(row.id) || null,
      amount: Number(row.amount) || 0,
      bankName: row.bankName || '',
      accountTitle: row.accountTitle || '',
      accountNumber: row.accountNumber || '',
      transactionType: row.transactionType || 'Cash Deposit',
      transactionReference: row.transactionReference || '',
      reason: row.reason || ''
    }));

    return res.status(200).json({
      dailyEntryId,
      cdDateTime,
      bankTransfers
    });
  } catch (err) {
    console.error('getBankTransfersByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }
  }
};

/* exports.saveBankTransfers = async (req, res) => {
  let connection;
  try {

    connection = await db.getConnection();
    console.log('saveBankTransfers: Start');
    const {
      daily_entry_id,
      existing_transfers,
      new_transfers,
      removed_transfer_ids,
      current_user
    } = req.body;

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    const currentUser = current_user || 'System';

    await connection.beginTransaction();

    // Get the cash_management ID for this daily entry
    const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
    if (!cashManagementId) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ message: 'Cash management record not found for this daily entry' });
    }

    // 1. Get old total bank transfers before any changes
    const [oldTotalRows] = await connection.execute(
      `SELECT IFNULL(SUM(amount), 0) as total
       FROM cash_outflow_bank
       WHERE cash_management_id = ? AND Active = 1`,
      [cashManagementId]
    );
    const oldBankTotal = Number(oldTotalRows[0]?.total) || 0;

    // 2. Process existing transfers (UPDATE)
    if (Array.isArray(existing_transfers) && existing_transfers.length > 0) {
      for (const transfer of existing_transfers) {
        if (!transfer.id) continue;

        const selectedAccountId = transfer.accountId != null && transfer.accountId !== ''
          ? Number(transfer.accountId)
          : null;

        let bankNameForUpdate = (transfer.bankName || '').trim();
        let accountTitleForUpdate = (transfer.accountTitle || '').trim();
        let accountNumberForUpdate = (transfer.accountNumber || '').trim();

        if (selectedAccountId && Number.isFinite(selectedAccountId)) {
          const [[accountRow]] = await connection.execute(
            `SELECT a.AccountTitle, a.AccountNo, b.Name AS BankName
             FROM accounts a
             LEFT JOIN bank b ON b.ID = a.BankID
             WHERE a.ID = ?
             LIMIT 1`,
            [selectedAccountId]
          );
          if (accountRow) {
            bankNameForUpdate = String(accountRow.BankName || bankNameForUpdate).trim() || bankNameForUpdate;
            accountTitleForUpdate = String(accountRow.AccountTitle || accountTitleForUpdate).trim() || accountTitleForUpdate;
            accountNumberForUpdate = String(accountRow.AccountNo || accountNumberForUpdate).trim() || accountNumberForUpdate;
          }
        }

        await connection.execute(
          `UPDATE cash_outflow_bank
           SET amount = ?,
               bank_name = ?,
               account_title = ?,
               account_number = ?,
               transaction_type = ?,
               transaction_ref = ?,
               reason = ?,
               MD = NOW(),
               MB = ?
           WHERE id = ? AND cash_management_id = ? AND Active = 1`,
          [
            Number(transfer.amount) || 0,
            bankNameForUpdate || 'N/A',
            accountTitleForUpdate || null,
            accountNumberForUpdate || null,
            (transfer.transactionType || 'Cash Deposit').trim(),
            (transfer.transactionReference || '').trim() || null,
            (transfer.reason || '').trim() || null,
            currentUser,
            transfer.id,
            cashManagementId
          ]
        );
      }
    }

    // 3. Process new transfers (INSERT)
    if (Array.isArray(new_transfers) && new_transfers.length > 0) {
      for (const transfer of new_transfers) {
        const selectedAccountId = transfer.accountId != null && transfer.accountId !== ''
          ? Number(transfer.accountId)
          : null;

        let bankNameForInsert = (transfer.bankName || '').trim();
        let accountTitleForInsert = (transfer.accountTitle || '').trim();
        let accountNumberForInsert = (transfer.accountNumber || '').trim();

        if (selectedAccountId && Number.isFinite(selectedAccountId)) {
          const [[accountRow]] = await connection.execute(
            `SELECT a.AccountTitle, a.AccountNo, b.Name AS BankName
             FROM accounts a
             LEFT JOIN bank b ON b.ID = a.BankID
             WHERE a.ID = ?
             LIMIT 1`,
            [selectedAccountId]
          );
          if (accountRow) {
            bankNameForInsert = String(accountRow.BankName || bankNameForInsert).trim() || bankNameForInsert;
            accountTitleForInsert = String(accountRow.AccountTitle || accountTitleForInsert).trim() || accountTitleForInsert;
            accountNumberForInsert = String(accountRow.AccountNo || accountNumberForInsert).trim() || accountNumberForInsert;
          }
        }

        await connection.execute(
          `INSERT INTO cash_outflow_bank
           (cash_management_id, amount, bank_name, account_title, account_number,
            transaction_type, transaction_ref, reason, Active, CB, CD, MB, MD)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
          [
            cashManagementId,
            Number(transfer.amount) || 0,
            bankNameForInsert || 'N/A',
            accountTitleForInsert || null,
            accountNumberForInsert || null,
            (transfer.transactionType || 'Cash Deposit').trim(),
            (transfer.transactionReference || '').trim() || null,
            (transfer.reason || '').trim() || null,
            currentUser,
            currentUser
          ]
        );
      }
    }

    // 4. Process removed transfers (soft delete)
    if (Array.isArray(removed_transfer_ids) && removed_transfer_ids.length > 0) {
      const placeholders = removed_transfer_ids.map(() => '?').join(',');
      await connection.execute(
        `UPDATE cash_outflow_bank
         SET Active = 0, MD = NOW(), MB = ?
         WHERE id IN (${placeholders}) AND cash_management_id = ?`,
        [currentUser, ...removed_transfer_ids, cashManagementId]
      );
    }

    // 5. Get new total bank transfers after changes
    const [newTotalRows] = await connection.execute(
      `SELECT IFNULL(SUM(amount), 0) as total
       FROM cash_outflow_bank
       WHERE cash_management_id = ? AND Active = 1`,
      [cashManagementId]
    );
    const newBankTotal = Number(newTotalRows[0]?.total) || 0;
    const bankNetChange = newBankTotal - oldBankTotal;


    // 6. Get current cash management values
    const [cashMgmtRows] = await connection.execute(
      `SELECT total_cash_in_hand, total_cash_outflow
   FROM cash_management
   WHERE id = ? FOR UPDATE`,
      [cashManagementId]
    );

    if (!cashMgmtRows || cashMgmtRows.length === 0) {
      throw new Error('Cash management record vanished');
    }

    const oldTotalCashOutflow = Number(cashMgmtRows[0].total_cash_outflow) || 0;
    const totalCashInHand = Number(cashMgmtRows[0].total_cash_in_hand) || 0;

    // Calculate new values
    const newTotalCashOutflow = oldTotalCashOutflow + bankNetChange;
    const newFinalCashInHand = totalCashInHand - newTotalCashOutflow;

    // Update with absolute values (no sequential dependency)
    await connection.execute(
      `UPDATE cash_management
   SET total_cash_outflow = ?,
       final_cash_in_hand = ?,
       MD = NOW(),
       MB = ?
   WHERE id = ?`,
      [newTotalCashOutflow, newFinalCashInHand, currentUser, cashManagementId]
    );

    await connection.commit();
    connection.release();

    console.log('saveBankTransfers: Success');
    return res.status(200).json({ message: 'Bank transfers saved successfully' });

  } catch (error) {
    console.error('saveBankTransfers: Error', error);
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  } finally {
    if (connection) { connection.release(); }
  }
}; */
exports.saveBankTransfers = async (req, res) => {
  let connection;

  try {
    connection = await db.getConnection();
    console.log('saveBankTransfers: Start');
    const {
      daily_entry_id,
      existing_transfers,
      new_transfers,
      removed_transfer_ids,
      current_user
    } = req.body;

    if (!daily_entry_id) {
      // ✅ Let finally handle release
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    const currentUser = current_user || 'System';

    await connection.beginTransaction();

    // Get the cash_management ID for this daily entry
    const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
    if (!cashManagementId) {
      // ✅ Rollback and let finally handle release
      await connection.rollback();
      return res.status(404).json({ message: 'Cash management record not found for this daily entry' });
    }

    // 1. Get old total bank transfers before any changes
    const [oldTotalRows] = await connection.execute(
      `SELECT IFNULL(SUM(amount), 0) as total
       FROM cash_outflow_bank
       WHERE cash_management_id = ? AND Active = 1`,
      [cashManagementId]
    );
    const oldBankTotal = Number(oldTotalRows[0]?.total) || 0;

    // 2. Process existing transfers (UPDATE)
    if (Array.isArray(existing_transfers) && existing_transfers.length > 0) {
      for (const transfer of existing_transfers) {
        if (!transfer.id) continue;

        const selectedAccountId = transfer.accountId != null && transfer.accountId !== ''
          ? Number(transfer.accountId)
          : null;

        let bankNameForUpdate = (transfer.bankName || '').trim();
        let accountTitleForUpdate = (transfer.accountTitle || '').trim();
        let accountNumberForUpdate = (transfer.accountNumber || '').trim();

        if (selectedAccountId && Number.isFinite(selectedAccountId)) {
          const [[accountRow]] = await connection.execute(
            `SELECT a.AccountTitle, a.AccountNo, b.Name AS BankName
             FROM accounts a
             LEFT JOIN bank b ON b.ID = a.BankID
             WHERE a.ID = ?
             LIMIT 1`,
            [selectedAccountId]
          );
          if (accountRow) {
            bankNameForUpdate = String(accountRow.BankName || bankNameForUpdate).trim() || bankNameForUpdate;
            accountTitleForUpdate = String(accountRow.AccountTitle || accountTitleForUpdate).trim() || accountTitleForUpdate;
            accountNumberForUpdate = String(accountRow.AccountNo || accountNumberForUpdate).trim() || accountNumberForUpdate;
          }
        }

        await connection.execute(
          `UPDATE cash_outflow_bank
           SET amount = ?,
               bank_name = ?,
               account_title = ?,
               account_number = ?,
               transaction_type = ?,
               transaction_ref = ?,
               reason = ?,
               MD = NOW(),
               MB = ?
           WHERE id = ? AND cash_management_id = ? AND Active = 1`,
          [
            Number(transfer.amount) || 0,
            bankNameForUpdate || 'N/A',
            accountTitleForUpdate || null,
            accountNumberForUpdate || null,
            (transfer.transactionType || 'Cash Deposit').trim(),
            (transfer.transactionReference || '').trim() || null,
            (transfer.reason || '').trim() || null,
            currentUser,
            transfer.id,
            cashManagementId
          ]
        );
      }
    }

    // 3. Process new transfers (INSERT)
    if (Array.isArray(new_transfers) && new_transfers.length > 0) {
      for (const transfer of new_transfers) {
        const selectedAccountId = transfer.accountId != null && transfer.accountId !== ''
          ? Number(transfer.accountId)
          : null;

        let bankNameForInsert = (transfer.bankName || '').trim();
        let accountTitleForInsert = (transfer.accountTitle || '').trim();
        let accountNumberForInsert = (transfer.accountNumber || '').trim();

        if (selectedAccountId && Number.isFinite(selectedAccountId)) {
          const [[accountRow]] = await connection.execute(
            `SELECT a.AccountTitle, a.AccountNo, b.Name AS BankName
             FROM accounts a
             LEFT JOIN bank b ON b.ID = a.BankID
             WHERE a.ID = ?
             LIMIT 1`,
            [selectedAccountId]
          );
          if (accountRow) {
            bankNameForInsert = String(accountRow.BankName || bankNameForInsert).trim() || bankNameForInsert;
            accountTitleForInsert = String(accountRow.AccountTitle || accountTitleForInsert).trim() || accountTitleForInsert;
            accountNumberForInsert = String(accountRow.AccountNo || accountNumberForInsert).trim() || accountNumberForInsert;
          }
        }

        await connection.execute(
          `INSERT INTO cash_outflow_bank
           (cash_management_id, amount, bank_name, account_title, account_number,
            transaction_type, transaction_ref, reason, Active, CB, CD, MB, MD)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
          [
            cashManagementId,
            Number(transfer.amount) || 0,
            bankNameForInsert || 'N/A',
            accountTitleForInsert || null,
            accountNumberForInsert || null,
            (transfer.transactionType || 'Cash Deposit').trim(),
            (transfer.transactionReference || '').trim() || null,
            (transfer.reason || '').trim() || null,
            currentUser,
            currentUser
          ]
        );
      }
    }

    // 4. Process removed transfers (soft delete)
    if (Array.isArray(removed_transfer_ids) && removed_transfer_ids.length > 0) {
      const placeholders = removed_transfer_ids.map(() => '?').join(',');
      await connection.execute(
        `UPDATE cash_outflow_bank
         SET Active = 0, MD = NOW(), MB = ?
         WHERE id IN (${placeholders}) AND cash_management_id = ?`,
        [currentUser, ...removed_transfer_ids, cashManagementId]
      );
    }

    // 5. Get new total bank transfers after changes
    const [newTotalRows] = await connection.execute(
      `SELECT IFNULL(SUM(amount), 0) as total
       FROM cash_outflow_bank
       WHERE cash_management_id = ? AND Active = 1`,
      [cashManagementId]
    );
    const newBankTotal = Number(newTotalRows[0]?.total) || 0;
    const bankNetChange = newBankTotal - oldBankTotal;

    // 6. Get current cash management values
    const [cashMgmtRows] = await connection.execute(
      `SELECT total_cash_in_hand, total_cash_outflow
       FROM cash_management
       WHERE id = ? FOR UPDATE`,
      [cashManagementId]
    );

    if (!cashMgmtRows || cashMgmtRows.length === 0) {
      throw new Error('Cash management record vanished');
    }

    const oldTotalCashOutflow = Number(cashMgmtRows[0].total_cash_outflow) || 0;
    const totalCashInHand = Number(cashMgmtRows[0].total_cash_in_hand) || 0;

    // Calculate new values
    const newTotalCashOutflow = oldTotalCashOutflow + bankNetChange;
    const newFinalCashInHand = totalCashInHand - newTotalCashOutflow;

    // Update with absolute values
    await connection.execute(
      `UPDATE cash_management
       SET total_cash_outflow = ?,
           final_cash_in_hand = ?,
           MD = NOW(),
           MB = ?
       WHERE id = ?`,
      [newTotalCashOutflow, newFinalCashInHand, currentUser, cashManagementId]
    );

    // ✅ Commit - NO manual release here
    await connection.commit();

    console.log('saveBankTransfers: Success');
    return res.status(200).json({ message: 'Bank transfers saved successfully' });

  } catch (error) {
    // ✅ Rollback if transaction was started
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }

    console.error('saveBankTransfers: Error', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });

  } finally {
    // ✅ Single release point
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr.message);
      }
    }
  }
};




// Full petrol pump report from daily sales entry submit data (date range)
exports.getPumpDailyEntryReport = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    const pumpId = Number(req.query.pump_id || 0);
    const startDate = normalizeDateFormat(req.query.startDate);
    const endDate = normalizeDateFormat(req.query.endDate);

    if (!pumpId || !startDate || !endDate) {
      return res.status(400).json({ message: 'pump_id, startDate and endDate are required' });
    }

    const [pumpRows] = await connection.execute(
      `SELECT id, name, location
       FROM petrol_pumps
       WHERE id = ? AND Active = 1
       LIMIT 1`,
      [pumpId]
    );

    const pumpInfo = pumpRows && pumpRows.length > 0
      ? pumpRows[0]
      : { id: pumpId, name: 'N/A', location: 'N/A' };

    const [entries] = await connection.execute(
      `SELECT id, pump_id, entry_date, status, submitted_at, CB, MB, cd, md
       FROM daily_sales_entries
       WHERE pump_id = ?
         AND CAST(entry_date AS DATE) BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
         AND Active = 1
       ORDER BY entry_date DESC, id DESC`,
      [pumpId, startDate, endDate]
    );

    const dailyEntries = entries || [];
    const entryIds = dailyEntries.map((entry) => Number(entry.id)).filter((id) => id > 0);

    if (entryIds.length === 0) {
      return res.json({
        pump: {
          id: Number(pumpInfo.id || pumpId),
          name: pumpInfo.name || 'N/A',
          phone: pumpInfo.phone || ''
        },
        summary: {
          totalEntries: 0,
          totalFuelSold: 0,
          totalNozzleSalesAmount: 0,
          totalExpenses: 0,
          totalRecoveries: 0,
          totalCreditSales: 0,
          totalMobileOilSales: 0,
          totalCashInHand: 0,
          totalCashOutflow: 0,
          finalCashInHand: 0
        },
        datasets: {
          entries: [],
          entryStaff: [],
          nozzleReadings: [],
          machineReadings: [],
          mobileOilCashSales: [],
          dailyExpenses: [],
          cashManagement: [],
          cashOutflowNet: [],
          cashOutflowBank: [],
          cashOutflowOwner: [],
          creditSales: [],
          recoveries: [],
          tankInventory: [],
          pumpAdvances: []
        }
      });
    }

    const placeholders = entryIds.map(() => '?').join(', ');

    const [entryStaffRows] = await connection.execute(
      `SELECT des.id, des.daily_entry_id, des.pumpid, des.staffid,
              s.name AS staff_name, s.phone AS staff_phone, s.designation
       FROM daily_sales_entry_staff des
       LEFT JOIN staff s ON s.id = des.staffid
       WHERE des.daily_entry_id IN (${placeholders})
         AND des.Active = 1
       ORDER BY des.daily_entry_id DESC, des.id DESC`,
      entryIds
    );

    const [nozzleRows] = await connection.execute(
      `SELECT nr.id, nr.daily_entry_id, dse.entry_date, nr.nozzle_id,
              nr.opening_digital_reading, nr.closing_digital_reading,
              nr.opening_mechanical_reading, nr.closing_mechanical_reading,
              nr.total_sold, nr.sales_amount,
              nz.nozzle_number,
              nz.nozzle_type AS fuel_type,
              mc.machine_number,
              tank_map.tank_numbers
       FROM nozzle_readings nr
       INNER JOIN daily_sales_entries dse ON dse.id = nr.daily_entry_id
       LEFT JOIN nozzles nz ON nz.id = nr.nozzle_id
       LEFT JOIN machines mc ON mc.id = nz.machine_id
       LEFT JOIN (
         SELECT
           pump_id,
           LOWER(TRIM(fuel_type)) AS fuel_key,
           GROUP_CONCAT(DISTINCT tank_number ORDER BY tank_number SEPARATOR ', ') AS tank_numbers
         FROM fuel_tanks
         WHERE Active = 1
         GROUP BY pump_id, LOWER(TRIM(fuel_type))
       ) tank_map ON tank_map.pump_id = dse.pump_id
                AND tank_map.fuel_key = LOWER(TRIM(COALESCE(nz.nozzle_type, '')))
       WHERE nr.daily_entry_id IN (${placeholders})
         AND nr.Active = 1
       ORDER BY dse.entry_date DESC, nr.id DESC`,
      entryIds
    );

    const [machineRows] = await connection.execute(
      `SELECT mr.id, mr.daily_entry_id, dse.entry_date,
              mr.machine_id, mr.total_digital_sales, mr.total_mechanical_sales, mr.total_sales
       FROM machine_readings mr
       INNER JOIN daily_sales_entries dse ON dse.id = mr.daily_entry_id
       WHERE mr.daily_entry_id IN (${placeholders})
         AND mr.Active = 1
       ORDER BY dse.entry_date DESC, mr.id DESC`,
      entryIds
    );

    const [mobileOilRows] = await connection.execute(
      `SELECT mos.id, mos.daily_entry_id, dse.entry_date, mos.pump_id,
              mos.liters_sold, mos.rate_per_liter, mos.total_amount,
              mos.container_type, mos.container_liters, mos.no_of_containers
       FROM mobile_oil_cash_sales mos
       INNER JOIN daily_sales_entries dse ON dse.id = mos.daily_entry_id
       WHERE mos.daily_entry_id IN (${placeholders})
         AND mos.Active = 1
       ORDER BY dse.entry_date DESC, mos.id DESC`,
      entryIds
    );

    const [expenseRows] = await connection.execute(
      `SELECT de.id, cm.daily_entry_id AS daily_entry_id, dse.entry_date,
              de.expense_category AS category_id,
              COALESCE(ec.name, 'Other') AS category_name,
              de.amount, de.description
       FROM daily_expenses de
       INNER JOIN cash_management cm ON cm.id = de.cash_management_id AND cm.Active = 1
       INNER JOIN daily_sales_entries dse ON dse.id = cm.daily_entry_id AND dse.Active = 1
       LEFT JOIN expense_categories ec ON ec.id = de.expense_category
       WHERE dse.pump_id = ?
         AND DATE(dse.entry_date) BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
         AND de.Active = 1
       ORDER BY dse.entry_date DESC, de.id DESC`,
      [pumpId, startDate, endDate]
    );

    // pump_advance query
    const [pumpAdvanceRows] = await connection.execute(
      ` SELECT pa.id,
       pa.cash_management_id,
       cm.daily_entry_id,
       dse.entry_date,
       pa.amount,
       pa.pump_id,
       p.name AS pump_name,               -- pump name from pump table
       pa.reference_name,
       pa.purpose,
       pa.CB,
       pa.MB,
       pa.CD,
       pa.MD,
       pa.Active
FROM pump_advance pa
INNER JOIN cash_management cm ON cm.id = pa.cash_management_id AND cm.Active = 1
INNER JOIN daily_sales_entries dse ON dse.id = cm.daily_entry_id AND dse.Active = 1
INNER JOIN petrol_pumps p ON p.id = pa.pump_id   -- join to get pump name
WHERE pa.Active = 1                       -- filter active pump advances
ORDER BY dse.entry_date DESC, pa.id DESC`,
      [pumpId, startDate, endDate]
    );

    const [cashMgmtRows] = await connection.execute(
      `SELECT cm.id, cm.daily_entry_id, dse.entry_date,
              cm.cash_from_previous_day, cm.cash_from_previous_night,
              cm.other_income, cm.cash_from_recovery,
              cm.total_cash_in_hand, cm.total_cash_outflow, cm.final_cash_in_hand
       FROM cash_management cm
       INNER JOIN daily_sales_entries dse ON dse.id = cm.daily_entry_id
       WHERE cm.daily_entry_id IN (${placeholders})
         AND cm.Active = 1
       ORDER BY dse.entry_date DESC, cm.id DESC`,
      entryIds
    );

    const cashMgmtIds = (cashMgmtRows || []).map((row) => Number(row.id)).filter((id) => id > 0);
    let cashOutflowNetRows = [];
    let cashOutflowBankRows = [];
    let cashOutflowOwnerRows = [];

    if (cashMgmtIds.length > 0) {
      const cmPlaceholders = cashMgmtIds.map(() => '?').join(', ');

      const [netRows] = await connection.execute(
        `SELECT con.id, con.cash_management_id, cm.daily_entry_id, dse.entry_date,
                con.amount, con.recipient_name, con.recipient_role, con.reason, con.receipt_number
         FROM cash_outflow_net con
         INNER JOIN cash_management cm ON cm.id = con.cash_management_id
         INNER JOIN daily_sales_entries dse ON dse.id = cm.daily_entry_id
         WHERE con.cash_management_id IN (${cmPlaceholders})
           AND con.Active = 1
         ORDER BY dse.entry_date DESC, con.id DESC`,
        cashMgmtIds
      );
      cashOutflowNetRows = netRows || [];

      const [bankRows] = await connection.execute(
        `SELECT cob.id, cob.cash_management_id, cm.daily_entry_id, dse.entry_date,
                cob.amount, cob.bank_name, cob.account_title, cob.account_number,
                cob.transaction_type, cob.transaction_ref, cob.reason
         FROM cash_outflow_bank cob
         INNER JOIN cash_management cm ON cm.id = cob.cash_management_id
         INNER JOIN daily_sales_entries dse ON dse.id = cm.daily_entry_id
         WHERE cob.cash_management_id IN (${cmPlaceholders})
           AND cob.Active = 1
         ORDER BY dse.entry_date DESC, cob.id DESC`,
        cashMgmtIds
      );
      cashOutflowBankRows = bankRows || [];

      const [ownerRows] = await connection.execute(
        `SELECT coo.id, coo.cash_management_id, cm.daily_entry_id, dse.entry_date,
                coo.amount, coo.person_type, coo.person_name, coo.person_id AS personId, coo.purpose, coo.notes
         FROM cash_outflow_owner coo
         INNER JOIN cash_management cm ON cm.id = coo.cash_management_id
         INNER JOIN daily_sales_entries dse ON dse.id = cm.daily_entry_id
         WHERE coo.cash_management_id IN (${cmPlaceholders})
           AND coo.Active = 1
         ORDER BY dse.entry_date DESC, coo.id DESC`,
        cashMgmtIds
      );
      cashOutflowOwnerRows = ownerRows || [];
    }

    const [creditSalesRows] = await connection.execute(
      `SELECT cs.id, cs.daily_entry_id, dse.entry_date,
              cs.fuel_station_customer_id, cs.ws_customer_id, cs.customer_vehicle_id,
              cs.fuel_type, cs.quantity_liters, cs.rate_per_liter, cs.total_amount,
              cs.price_type, cs.specific_price, cs.notes,
              COALESCE(fsc.customer_name, wc.name) AS customer_name,
              fscv.vehicle_number,
              COALESCE(ft.name, cs.fuel_type) AS fuel_type_name
       FROM credit_sales cs
       INNER JOIN daily_sales_entries dse ON dse.id = cs.daily_entry_id
       LEFT JOIN fuel_station_customer fsc ON cs.fuel_station_customer_id = fsc.customer_id
       LEFT JOIN customers wc ON cs.ws_customer_id = wc.id
       LEFT JOIN fuele_station_customer_vehicles fscv ON cs.customer_vehicle_id = fscv.vehicle_id
       LEFT JOIN fuel_types ft ON CAST(cs.fuel_type AS UNSIGNED) = ft.id OR LOWER(ft.name) = LOWER(cs.fuel_type)
       WHERE cs.daily_entry_id IN (${placeholders})
         AND cs.Active = 1
       ORDER BY dse.entry_date DESC, cs.id DESC`,
      entryIds
    );

    const [recoveryRows] = await connection.execute(
      `SELECT fscr.id,
              fscr.station_id,
              fscr.customer_id,
              fscr.ws_customer_id,
              fscr.recovery_date,
              fscr.amount,
              fscr.payment_mode,
              fscr.reference,
              COALESCE(wc.name, fsc.customer_name) AS customer_name,
              CASE
                WHEN fscr.ws_customer_id IS NOT NULL THEN 'Supplier'
                WHEN fscr.customer_id IS NOT NULL THEN 'Local'
                ELSE 'N/A'
              END AS customer_type
       FROM fuel_station_customer_recoveries fscr
       LEFT JOIN customers wc ON fscr.ws_customer_id = wc.id
       LEFT JOIN fuel_station_customer fsc ON fscr.customer_id = fsc.customer_id
       WHERE CAST(fscr.recovery_date AS DATE) BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
         AND fscr.station_id = ?
         AND fscr.Active = 1
       ORDER BY fscr.recovery_date DESC, fscr.id DESC`,
      [startDate, endDate, pumpId]
    );

    const [tankRows] = await connection.execute(
      `SELECT dti.id, dti.daily_entry_id, dse.entry_date,
              dti.tank_id, ft.fuel_type, dti.opening_level, dti.closing_level,
              dti.received_quantity, dti.sold_quantity, dti.purchase_reference
       FROM daily_tank_inventory dti
       INNER JOIN daily_sales_entries dse ON dse.id = dti.daily_entry_id
       LEFT JOIN fuel_tanks ft ON ft.id = dti.tank_id
       WHERE dti.daily_entry_id IN (${placeholders})
         AND dti.Active = 1
       ORDER BY dse.entry_date DESC, dti.id DESC`,
      entryIds
    );

    const totalFuelSold = (nozzleRows || []).reduce((sum, row) => sum + (Number(row.total_sold) || 0), 0);
    const totalNozzleSalesAmount = (nozzleRows || []).reduce((sum, row) => sum + (Number(row.sales_amount) || 0), 0);
    const totalExpenses = (expenseRows || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const totalRecoveries = (recoveryRows || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const totalCreditSales = (creditSalesRows || []).reduce((sum, row) => sum + (Number(row.total_amount) || 0), 0);
    const totalMobileOilSales = (mobileOilRows || []).reduce((sum, row) => sum + (Number(row.total_amount) || 0), 0);
    //const totalCashInHand = (cashMgmtRows || []).reduce((sum, row) => sum + (Number(row.total_cash_in_hand) || 0), 0);
    const totalCashInHand = (cashMgmtRows || []).reduce((sum, row) => sum + (Number(row.final_cash_in_hand) || 0), 0);
    console.log('totalCashInHand ' + totalCashInHand);
    const totalCashOutflow =
      (cashOutflowNetRows || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0) +
      (cashOutflowBankRows || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0) +
      (cashOutflowOwnerRows || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const previousDayCash = cashMgmtRows && cashMgmtRows.length > 0
      ? (Number(cashMgmtRows[0].cash_from_previous_day) || 0)
      : 0;
    const finalCashInHand = cashMgmtRows && cashMgmtRows.length > 0
      ? (Number(cashMgmtRows[0].final_cash_in_hand) || 0)
      : 0;

    const productWiseMap = {};
    const upsertProduct = (name, liters = 0, amount = 0, credit = 0) => {
      const key = String(name || 'Unknown').trim() || 'Unknown';
      if (!productWiseMap[key]) {
        productWiseMap[key] = {
          product: key,
          litersSold: 0,
          totalSales: 0,
          totalCreditSales: 0
        };
      }
      productWiseMap[key].litersSold += Number(liters) || 0;
      productWiseMap[key].totalSales += Number(amount) || 0;
      productWiseMap[key].totalCreditSales += Number(credit) || 0;
    };

    (nozzleRows || []).forEach((row) => {
      upsertProduct(row.fuel_type || 'Fuel', row.total_sold, row.sales_amount, 0);
    });

    (mobileOilRows || []).forEach((row) => {
      upsertProduct('Mobile Oil', row.liters_sold, row.total_amount, 0);
    });

    (creditSalesRows || []).forEach((row) => {
      upsertProduct(row.fuel_type_name || row.fuel_type || 'Fuel', row.quantity_liters, 0, row.total_amount);
    });

    const productWiseTotals = Object.values(productWiseMap).sort((a, b) => {
      return String(a.product).localeCompare(String(b.product));
    });

    const totalSalesAmount = totalNozzleSalesAmount + totalMobileOilSales;
    const pumpWiseTotals = [{
      pump_id: Number(pumpInfo.id || pumpId),
      pump_name: pumpInfo.name || 'N/A',
      totalEntries: dailyEntries.length,
      totalFuelSold,
      totalSalesAmount,
      totalCashReceived: totalCashInHand,
      totalCreditSales,
      totalExpenses,
      totalRecoveries,
      finalCashInHand
    }];

    return res.json({
      pump: {
        id: Number(pumpInfo.id || pumpId),
        name: pumpInfo.name || 'N/A',
        phone: pumpInfo.phone || ''
      },
      summary: {
        totalEntries: dailyEntries.length,
        totalFuelSold,
        totalNozzleSalesAmount,
        totalSalesAmount,
        totalCashReceived: totalCashInHand,
        totalExpenses,
        totalRecoveries,
        totalCreditSales,
        totalMobileOilSales,
        totalCashInHand,
        totalCashOutflow,
        previousDayCash,
        finalCashInHand
      },
      aggregates: {
        productWiseTotals,
        pumpWiseTotals
      },
      datasets: {
        entries: dailyEntries,
        entryStaff: entryStaffRows || [],
        nozzleReadings: nozzleRows || [],
        machineReadings: machineRows || [],
        mobileOilCashSales: mobileOilRows || [],
        dailyExpenses: expenseRows || [],
        cashManagement: cashMgmtRows || [],
        cashOutflowNet: cashOutflowNetRows,
        cashOutflowBank: cashOutflowBankRows,
        cashOutflowOwner: cashOutflowOwnerRows,
        creditSales: creditSalesRows || [],
        recoveries: recoveryRows || [],
        tankInventory: tankRows || [],
        pumpAdvances: pumpAdvanceRows || []
      }
    });
  } catch (err) {
    console.error('getPumpDailyEntryReport error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }
  }
};


//Load Withdrawls by date for a pump (for cash management section in daily entry form)
exports.getWithdrawalsByDate = async (req, res) => {

  let connection;
  try {

    connection = await db.getConnection();
    //console.log('getWithdrawalsByDate: Start');
    const { date, pumpId } = req.query;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }
    if (!pumpId) {
      return res.status(400).json({ message: 'Pump ID is required' });
    }

    const normalizedDate = normalizeDateFormat(date);
    const [entries] = await connection.execute(
      `SELECT id, CD
         FROM daily_sales_entries
         WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 order by id desc
         LIMIT 1`,
      [pumpId, normalizedDate]
    );

    if (entries.length === 0) {
      //console.log('getWithdrawalsByDate: No daily entry found for this date');
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        withdrawals: []
      });
    }

    const dailyEntryId = entries[0].id;
    const cdDateTime = entries[0].CD;

    // Get the latest cash_management record for this daily entry

    const cashsql = `SELECT id
             FROM cash_management
             WHERE daily_entry_id = ? AND Active = 1
             ORDER BY id DESC
             LIMIT 1`;
    const cashparams = [dailyEntryId];

    //console.log('SQL:', cashsql);
    //console.log('Parameters:', cashparams);
    const [cmRows] = await connection.execute(
      `SELECT id
         FROM cash_management
         WHERE daily_entry_id = ? AND Active = 1
         ORDER BY id DESC
         LIMIT 1`,
      [dailyEntryId]
    );

    if (!cmRows || cmRows.length === 0) {
      //console.log('getWithdrawalsByDate: No cash management record found');
      return res.status(200).json({
        dailyEntryId,
        cdDateTime,
        withdrawals: []
      });
    }

    const cashManagementId = Number(cmRows[0].id);

    // Fetch all owner withdrawals for this cash_management record

    const creditsql = `SELECT id,
              amount,
              person_type AS personType,
              person_name AS personName,
              purpose,
              notes AS additionalNotes
         FROM cash_outflow_owner
         WHERE cash_management_id = ? AND Active = 1
         ORDER BY id ASC`;
    const creditparams = [cashManagementId];

    //console.log('SQL:', creditsql);
    //console.log('Parameters:', creditparams);
    const [withdrawalRows] = await connection.execute(
      `SELECT id,
              amount,
              person_type AS personType,
              person_name AS personName,
              person_id AS personId,
              purpose,
              notes AS additionalNotes
         FROM cash_outflow_owner
         WHERE cash_management_id = ? AND Active = 1
         ORDER BY id ASC`,
      [cashManagementId]
    );

    //console.log('getWithdrawalsByDate: Withdrawals found', JSON.stringify(withdrawalRows));

    const withdrawals = (withdrawalRows || []).map((row) => ({
      id: Number(row.id) || null,
      amount: Number(row.amount) || 0,
      personType: row.personType || 'Unknown',
      personName: row.personName || 'Unknown',
      personId: row.personId != null ? Number(row.personId) : null,
      purpose: row.purpose || '',
      additionalNotes: row.additionalNotes || ''
    }));

    return res.status(200).json({
      dailyEntryId,
      cdDateTime,
      withdrawals
    });
  } catch (err) {
    console.error('getWithdrawalsByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  } finally {
    if (connection) { connection.release(); }
  }
};

//Save Withdrawals for a daily entry (cash management section in daily entry form)
exports.saveWithdrawals_old = async (req, res) => {
  let connection;
  try {

    connection = await db.getConnection();
    //console.log('saveWithdrawals: Start');
    const {
      daily_entry_id,
      existing_withdrawals,
      new_withdrawals,
      removed_withdrawal_ids,
      current_user
    } = req.body;

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    const currentUser = current_user || 'System';

    await connection.beginTransaction();

    // Get the cash_management ID for this daily entry
    const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
    if (!cashManagementId) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ message: 'Cash management record not found for this daily entry' });
    }

    // 1. Get old total owner withdrawals before any changes
    const [oldTotalRows] = await connection.execute(
      `SELECT IFNULL(SUM(amount), 0) as total
       FROM cash_outflow_owner
       WHERE cash_management_id = ? AND Active = 1`,
      [cashManagementId]
    );
    const oldOwnerTotal = Number(oldTotalRows[0]?.total) || 0;

    // 2. Process existing withdrawals (UPDATE)
    if (Array.isArray(existing_withdrawals) && existing_withdrawals.length > 0) {
      for (const withdrawal of existing_withdrawals) {
        //console.log('Processing existing withdrawal:', withdrawal);
        if (!withdrawal.id) continue;

        await connection.execute(
          `UPDATE cash_outflow_owner
           SET amount = ?,
               person_type = ?,
               person_name = ?,
               person_id = ?,
               purpose = ?,
               notes = ?,
               MD = NOW(),
               MB = ?
           WHERE id = ? AND cash_management_id = ? AND Active = 1`,
          [
            Number(withdrawal.amount) || 0,
            (withdrawal.personType || 'Manager').trim(),
            (withdrawal.personName || '').trim(),
            withdrawal.personId != null && withdrawal.personId !== '' ? Number(withdrawal.personId) : 0,
            (withdrawal.purpose || '').trim() || null,
            (withdrawal.additionalNotes || '').trim() || null,
            currentUser,
            withdrawal.id,
            cashManagementId
          ]
        );
      }
    }

    // 3. Process new withdrawals (INSERT)
    if (Array.isArray(new_withdrawals) && new_withdrawals.length > 0) {
      for (const withdrawal of new_withdrawals) {
        //console.log('Processing new withdrawal:', withdrawal);
        await connection.execute(
          `INSERT INTO cash_outflow_owner
           (cash_management_id, amount, person_type, person_name, person_id, purpose, notes,
            Active, CB, CD, MB, MD)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
          [
            cashManagementId,
            Number(withdrawal.amount) || 0,
            (withdrawal.personType || 'Manager').trim(),
            (withdrawal.personName || '').trim(),
            withdrawal.personId != null && withdrawal.personId !== '' ? Number(withdrawal.personId) : 0,
            (withdrawal.purpose || '').trim() || null,
            (withdrawal.additionalNotes || '').trim() || null,
            currentUser,
            currentUser
          ]
        );
      }
    }

    // 4. Process removed withdrawals (soft delete)
    if (Array.isArray(removed_withdrawal_ids) && removed_withdrawal_ids.length > 0) {
      //console.log('Processing removed withdrawal IDs:', removed_withdrawal_ids);
      const placeholders = removed_withdrawal_ids.map(() => '?').join(',');
      await connection.execute(
        `UPDATE cash_outflow_owner
         SET Active = 0, MD = NOW(), MB = ?
         WHERE id IN (${placeholders}) AND cash_management_id = ?`,
        [currentUser, ...removed_withdrawal_ids, cashManagementId]
      );
    }

    // 5. Get new total owner withdrawals after changes
    const [newTotalRows] = await connection.execute(
      `SELECT IFNULL(SUM(amount), 0) as total
       FROM cash_outflow_owner
       WHERE cash_management_id = ? AND Active = 1`,
      [cashManagementId]
    );
    const newOwnerTotal = Number(newTotalRows[0]?.total) || 0;
    const ownerNetChange = newOwnerTotal - oldOwnerTotal;

    // 6. Update cash_management totals (same as bank transfers)
    const [cashMgmtRows] = await connection.execute(
      `SELECT total_cash_in_hand, total_cash_outflow
       FROM cash_management
       WHERE id = ? FOR UPDATE`,
      [cashManagementId]
    );

    if (!cashMgmtRows || cashMgmtRows.length === 0) {
      throw new Error('Cash management record vanished');
    }

    const oldTotalCashOutflow = Number(cashMgmtRows[0].total_cash_outflow) || 0;
    const totalCashInHand = Number(cashMgmtRows[0].total_cash_in_hand) || 0;

    const newTotalCashOutflow = oldTotalCashOutflow + ownerNetChange;
    const newFinalCashInHand = totalCashInHand - newTotalCashOutflow;

    await connection.execute(
      `UPDATE cash_management
       SET total_cash_outflow = ?,
           final_cash_in_hand = ?,
           MD = NOW(),
           MB = ?
       WHERE id = ?`,
      [newTotalCashOutflow, newFinalCashInHand, currentUser, cashManagementId]
    );

    await connection.commit();
    connection.release();

    console.log('saveWithdrawals: Success');
    return res.status(200).json({ message: 'Withdrawals saved successfully' });

  } catch (error) {
    console.error('saveWithdrawals: Error', error);
    if (connection) {
      await connection.rollback();
      connection.release();
    }
    return res.status(500).json({ message: 'Internal server error', error: error.message });
  } finally {
    if (connection) { connection.release(); }
  }

};

exports.saveWithdrawals = async (req, res) => {
  let connection;

  try {
    connection = await db.getConnection();
    const {
      daily_entry_id,
      existing_withdrawals,
      new_withdrawals,
      removed_withdrawal_ids,
      current_user
    } = req.body;

    if (!daily_entry_id) {
      // ✅ Let finally handle release
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    const currentUser = current_user || 'System';

    await connection.beginTransaction();

    // Get the cash_management ID for this daily entry
    const cashManagementId = await getLatestCashManagementIdByDailyEntryId(connection, daily_entry_id);
    if (!cashManagementId) {
      // ✅ Rollback and let finally handle release
      await connection.rollback();
      return res.status(404).json({ message: 'Cash management record not found for this daily entry' });
    }

    // 1. Get old total owner withdrawals before any changes
    const [oldTotalRows] = await connection.execute(
      `SELECT IFNULL(SUM(amount), 0) as total
       FROM cash_outflow_owner
       WHERE cash_management_id = ? AND Active = 1`,
      [cashManagementId]
    );
    const oldOwnerTotal = Number(oldTotalRows[0]?.total) || 0;

    // 2. Process existing withdrawals (UPDATE)
    if (Array.isArray(existing_withdrawals) && existing_withdrawals.length > 0) {
      for (const withdrawal of existing_withdrawals) {
        if (!withdrawal.id) continue;

        await connection.execute(
          `UPDATE cash_outflow_owner
           SET amount = ?,
               person_type = ?,
               person_name = ?,
               person_id = ?,
               purpose = ?,
               notes = ?,
               MD = NOW(),
               MB = ?
           WHERE id = ? AND cash_management_id = ? AND Active = 1`,
          [
            Number(withdrawal.amount) || 0,
            (withdrawal.personType || 'Manager').trim(),
            (withdrawal.personName || '').trim(),
            withdrawal.personId != null && withdrawal.personId !== '' ? Number(withdrawal.personId) : 0,
            (withdrawal.purpose || '').trim() || null,
            (withdrawal.additionalNotes || '').trim() || null,
            currentUser,
            withdrawal.id,
            cashManagementId
          ]
        );
      }
    }

    // 3. Process new withdrawals (INSERT)
    if (Array.isArray(new_withdrawals) && new_withdrawals.length > 0) {
      for (const withdrawal of new_withdrawals) {
        await connection.execute(
          `INSERT INTO cash_outflow_owner
           (cash_management_id, amount, person_type, person_name, person_id, purpose, notes,
            Active, CB, CD, MB, MD)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
          [
            cashManagementId,
            Number(withdrawal.amount) || 0,
            (withdrawal.personType || 'Manager').trim(),
            (withdrawal.personName || '').trim(),
            withdrawal.personId != null && withdrawal.personId !== '' ? Number(withdrawal.personId) : 0,
            (withdrawal.purpose || '').trim() || null,
            (withdrawal.additionalNotes || '').trim() || null,
            currentUser,
            currentUser
          ]
        );
      }
    }

    // 4. Process removed withdrawals (soft delete)
    if (Array.isArray(removed_withdrawal_ids) && removed_withdrawal_ids.length > 0) {
      const placeholders = removed_withdrawal_ids.map(() => '?').join(',');
      await connection.execute(
        `UPDATE cash_outflow_owner
         SET Active = 0, MD = NOW(), MB = ?
         WHERE id IN (${placeholders}) AND cash_management_id = ?`,
        [currentUser, ...removed_withdrawal_ids, cashManagementId]
      );
    }

    // 5. Get new total owner withdrawals after changes
    const [newTotalRows] = await connection.execute(
      `SELECT IFNULL(SUM(amount), 0) as total
       FROM cash_outflow_owner
       WHERE cash_management_id = ? AND Active = 1`,
      [cashManagementId]
    );
    const newOwnerTotal = Number(newTotalRows[0]?.total) || 0;
    const ownerNetChange = newOwnerTotal - oldOwnerTotal;

    // 6. Update cash_management totals
    const [cashMgmtRows] = await connection.execute(
      `SELECT total_cash_in_hand, total_cash_outflow
       FROM cash_management
       WHERE id = ? FOR UPDATE`,
      [cashManagementId]
    );

    if (!cashMgmtRows || cashMgmtRows.length === 0) {
      throw new Error('Cash management record vanished');
    }

    const oldTotalCashOutflow = Number(cashMgmtRows[0].total_cash_outflow) || 0;
    const totalCashInHand = Number(cashMgmtRows[0].total_cash_in_hand) || 0;

    const newTotalCashOutflow = oldTotalCashOutflow + ownerNetChange;
    const newFinalCashInHand = totalCashInHand - newTotalCashOutflow;

    await connection.execute(
      `UPDATE cash_management
       SET total_cash_outflow = ?,
           final_cash_in_hand = ?,
           MD = NOW(),
           MB = ?
       WHERE id = ?`,
      [newTotalCashOutflow, newFinalCashInHand, currentUser, cashManagementId]
    );

    // ✅ Commit - NO manual release here
    await connection.commit();

    console.log('saveWithdrawals: Success');
    return res.status(200).json({ message: 'Withdrawals saved successfully' });

  } catch (error) {
    // ✅ Rollback if transaction was started
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackErr) {
        console.error('Rollback error:', rollbackErr);
      }
    }

    console.error('saveWithdrawals: Error', error);
    return res.status(500).json({
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });

  } finally {
    // ✅ Single release point
    if (connection) {
      try {
        connection.release();
      } catch (releaseErr) {
        console.error('Error releasing connection:', releaseErr.message);
      }
    }
  }
};