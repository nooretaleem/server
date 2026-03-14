const db = require('../models/db');

exports.getPumps = async (req, res) => {
  try {
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

    const [rows] = await db.execute(query);
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
  }
};

exports.getPumpDetails = async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ message: 'Pump ID is required' });
    }

    const [[pumpRows], [tankRows], [machineRows], [nozzleRows]] = await Promise.all([
      db.execute(
        `SELECT 
           pp.*,
           m.name AS manager_name,
           m.email AS manager_email
         FROM petrol_pumps pp
         LEFT JOIN users m ON pp.manager_id = m.id
         WHERE pp.id = ?`,
        [id]
      ),
      db.execute(
        `SELECT * 
         FROM fuel_tanks 
         WHERE pump_id = ? 
         ORDER BY fuel_type, tank_number`,
        [id]
      ),
      db.execute(
        `SELECT * 
         FROM machines 
         WHERE pump_id = ? 
         ORDER BY machine_number`,
        [id]
      ),
      db.execute(
        `SELECT nz.* 
         FROM nozzles nz
         JOIN machines mc ON nz.machine_id = mc.id
         WHERE mc.pump_id = ?
         ORDER BY mc.machine_number, nz.nozzle_number`,
        [id]
      )
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

    res.json({ pump, tanks, machines });
  } catch (err) {
    console.error('Error fetching pump details:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

exports.createPump = async (req, res) => {
  const payload = req.body || {};
  const pump = payload.pump || {};
  const tanks = Array.isArray(payload.tanks) ? payload.tanks : [];
  const machines = Array.isArray(payload.machines) ? payload.machines : [];

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    const CB = pump.CB || 'System';

    const [pumpResult] = await conn.execute(
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

    for (const t of tanks) {
      await conn.execute(
        `INSERT INTO fuel_tanks (
           pump_id, fuel_type, capacity, current_level, low_alert_level, tank_number,
           Active, CB, CD, MB, MD
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
        [
          pumpId,
          t.fuel_type || null,
          t.capacity != null ? t.capacity : null,
          t.current_level != null ? t.current_level : 0,
          t.low_alert_level != null ? t.low_alert_level : 0,
          t.tank_number != null ? t.tank_number : null,
          CB,
          CB
        ]
      );
    }

    for (const m of machines) {
      const [machineResult] = await conn.execute(
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
      const nozzles = Array.isArray(m.nozzles) ? m.nozzles : [];

      for (const nz of nozzles) {
        const initDigital = nz.initial_reading_digital != null ? nz.initial_reading_digital : 0;
        const initMech = nz.initial_reading_mechanical != null ? nz.initial_reading_mechanical : 0;
        const currDigital = nz.current_reading_digital != null ? nz.current_reading_digital : 0;
        const currMech = nz.current_reading_mechanical != null ? nz.current_reading_mechanical : 0;
        await conn.execute(
          `INSERT INTO nozzles (
             machine_id, nozzle_number, nozzle_type,
             initial_reading_digital, initial_reading_mechanical,
             current_reading_digital, current_reading_mechanical,
             Active, CB, CD, MB, MD
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
          [
            machineId,
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

    await conn.commit();

    res.json({
      message: 'Pump created successfully',
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
    console.error('Error creating pump:', err);
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

exports.updatePump = async (req, res) => {
  const payload = req.body || {};
  const pump = payload.pump || {};
  const pumpId = payload.id || pump.id;
  const tanks = Array.isArray(payload.tanks) ? payload.tanks : [];
  const machines = Array.isArray(payload.machines) ? payload.machines : [];

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
      for (const t of tanks) {
        const key = `${t.fuel_type || ''}-${t.tank_number || ''}`;
        const existingId = existingTankMap.get(key);

        if (existingId) {
          // Update existing tank
          await conn.execute(
            `UPDATE fuel_tanks SET
               capacity = ?,
               current_level = ?,
               low_alert_level = ?,
               Active = 1,
               MB = ?,
               MD = NOW()
             WHERE id = ?`,
            [
              t.capacity != null ? t.capacity : null,
              t.current_level != null ? t.current_level : 0,
              t.low_alert_level != null ? t.low_alert_level : 0,
              MB,
              existingId
            ]
          );
          processedTankIds.add(existingId);
        } else {
          // Before inserting, check for conflicting tanks (including inactive ones)
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
            await conn.execute(
              `INSERT INTO fuel_tanks (
                 pump_id, fuel_type, capacity, current_level, low_alert_level, tank_number,
                 Active, CB, CD, MB, MD
               ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
              [
                pumpId,
                t.fuel_type || null,
                t.capacity != null ? t.capacity : null,
                t.current_level != null ? t.current_level : 0,
                t.low_alert_level != null ? t.low_alert_level : 0,
                t.tank_number != null ? t.tank_number : null,
                MB,
                MB
              ]
            );
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
                await conn.execute(
                  `INSERT INTO fuel_tanks (
                     pump_id, fuel_type, capacity, current_level, low_alert_level, tank_number,
                     Active, CB, CD, MB, MD
                   ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
                  [
                    pumpId,
                    t.fuel_type || null,
                    t.capacity != null ? t.capacity : null,
                    t.current_level != null ? t.current_level : 0,
                    t.low_alert_level != null ? t.low_alert_level : 0,
                    t.tank_number != null ? t.tank_number : null,
                    MB,
                    MB
                  ]
                );
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
                   machine_id, nozzle_number, nozzle_type,
                   initial_reading_digital, initial_reading_mechanical,
                   current_reading_digital, current_reading_mechanical,
                   Active, CB, CD, MB, MD
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(), ?, NOW())`,
                [
                  machineId,
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

// Get tank inventory with low level alerts
exports.getTankInventory = async (req, res) => {
  try {
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
      const [resultRows] = await db.execute(query, params);
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
        WHERE ft.Active = 1
        ${pumpId ? ' AND ft.pump_id = ?' : ''}
        ORDER BY ft.pump_id, ft.fuel_type, ft.tank_number
      `;

      const [fallbackRows] = await db.execute(fallbackQuery, params);
      rows = fallbackRows || [];
    }

    const tanks = (rows || []).map(row => ({
      id: row.id,
      pump_id: row.pump_id,
      pump_name: row.pump_name,
      tank_type_id: row.tank_type_id,
      total_capacity_liters: parseFloat(row.total_capacity_liters) || 0,
      max_dip_mm: parseFloat(row.max_dip_mm) || 0,
      fuel_type: row.fuel_type,
      capacity: parseFloat(row.capacity) || 0,
      current_level: parseFloat(row.current_level) || 0,
      low_alert_level: parseFloat(row.low_alert_level) || 0,
      tank_number: row.tank_number,
      active: row.Active === 1,
      is_low_level: row.is_low_level === 1,
      alert_status: row.alert_status,
      percentage_full: parseFloat(row.percentage_full) || 0
    }));

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
  try {
    const tankTypeId = Number(req.query.tank_type_id);
    const dipMm = Number(req.query.dip_mm);

    if (!tankTypeId || Number.isNaN(tankTypeId)) {
      return res.status(400).json({ message: 'tank_type_id is required' });
    }
    if (Number.isNaN(dipMm) || dipMm < 0) {
      return res.status(400).json({ message: 'valid dip_mm is required' });
    }

    const [exactRows] = await db.execute(
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

    const [lowerRows] = await db.execute(
      `SELECT dip_mm, volume_liters
       FROM dip_chart
       WHERE tank_type_id = ? AND dip_mm <= ? AND Active = 1
       ORDER BY dip_mm DESC
       LIMIT 1`,
      [tankTypeId, dipMm]
    );

    const [upperRows] = await db.execute(
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
      return res.status(404).json({ message: 'No dip chart data found for this tank type' });
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
      return res.status(500).json({ message: 'dip_chart table not found' });
    }
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

/**
 * Check if dip readings exist for a pump on a given date.
 * Validation is based on DATE(physical_dip_readings.reading_time) for the selected date.
 * Query params: pump_id, entry_date (YYYY-MM-DD)
 * Returns: { hasDipReadings: boolean, daily_entry_id: number | null }
 */
exports.checkTodayDipReadings = async (req, res) => {
  try {
    const pumpId = req.query.pump_id;
    const entryDate = req.query.entry_date;
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }

    const [rows] = await db.execute(
      `SELECT pdr.daily_entry_id AS id
       FROM physical_dip_readings pdr
       INNER JOIN daily_sales_entries dse ON dse.id = pdr.daily_entry_id
       WHERE dse.pump_id = ?
         AND dse.Active = 1
         AND pdr.Active = 1
         AND DATE(pdr.reading_time) = ?
       LIMIT 1`,
      [pumpId, entryDate]
    );

    if (rows && rows.length > 0) {
      return res.json({ hasDipReadings: true, daily_entry_id: rows[0].id });
    }
    return res.json({ hasDipReadings: false, daily_entry_id: null });
  } catch (err) {
    console.error('Error checking dip readings:', err);
    res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

/**
 * Save dip readings for all tanks into physical_dip_readings.
 * Also creates/finds the daily_sales_entries record for that pump+date.
 * Body: { pump_id, entry_date (YYYY-MM-DD), shift, readings: [{tank_id, dip_mm, volume_liters}], CB, MB }
 * Returns: { success: true, daily_entry_id, message }
 */
exports.saveDipReadings = async (req, res) => {
  let connection;
  try {
    connection = await db.getConnection();
    const body = req.body || {};
    const pumpId = body.pump_id;
    const entryDate = body.entry_date;
    const readings = body.readings || [];
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

    // 1. Insert or get daily_sales_entries (status = Started unless already fully submitted)
    await connection.execute(
      `INSERT INTO daily_sales_entries (pump_id, entry_date, status, submitted_at, CB, MB, cd, md, Active)
       VALUES (?, ?, 'Started', NOW(), ?, ?, NOW(), NOW(), 1)
       ON DUPLICATE KEY UPDATE
         status = CASE WHEN status = 'submitted' THEN 'submitted' ELSE 'Started' END,
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

    // 2. Remove existing dip readings and tank inventory rows for this daily entry (allow re-save)
    await connection.execute(
      `DELETE FROM physical_dip_readings WHERE daily_entry_id = ?`,
      [dailyEntryId]
    );
    await connection.execute(
      `DELETE FROM daily_tank_inventory WHERE daily_entry_id = ?`,
      [dailyEntryId]
    );

    // 3. Insert each tank reading and update fuel_tanks.current_level
    let primaryKeyFixed = false;
    for (const r of readings) {
      try {
        await connection.execute(
          `INSERT INTO physical_dip_readings
             (daily_entry_id, tank_id, dip_level, volume_liters, reading_time, Active, CB, MB, CD, MD)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, NOW(), NOW())`,
          [dailyEntryId, r.tank_id, r.dip_mm, r.volume_liters || 0, entryDate, cb, mb]
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
             (daily_entry_id, tank_id, dip_level, volume_liters, reading_time, Active, CB, MB, CD, MD)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, NOW(), NOW())`,
          [dailyEntryId, r.tank_id, r.dip_mm, r.volume_liters || 0, entryDate, cb, mb]
        );
      }

      // Insert opening snapshot into daily_tank_inventory
      // closing_level, received_quantity, sold_quantity, purchase_reference left NULL — filled later
      await connection.execute(
        `INSERT INTO daily_tank_inventory
           (daily_entry_id, tank_id, opening_level,
            closing_level, received_quantity, sold_quantity, purchase_reference,
            CB, MB, cd, md, Active)
         VALUES (?, ?, ?,
                 NULL, NULL, NULL, NULL,
                 ?, ?, NOW(), NOW(), 1)`,
        [dailyEntryId, r.tank_id, r.volume_liters || 0, cb, mb]
      );

      // Update current stock level in fuel_tanks
      await connection.execute(
        `UPDATE fuel_tanks SET current_level = ?, MD = NOW() WHERE id = ? AND Active = 1`,
        [r.volume_liters || 0, r.tank_id]
      );
    }

    await connection.commit();
    connection.release();

    return res.json({
      success: true,
      daily_entry_id: dailyEntryId,
      message: `Dip readings saved successfully (${readings.length} tank${readings.length !== 1 ? 's' : ''})`
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

