const db = require('../models/db');

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

/**
 * Get latest closing_digital_reading and closing_mechanical_reading from nozzle_readings
 * for each nozzle of a pump (from the most recent daily entry before entry_date).
 * Used to pre-fill Opening fields in Step 2 (Meter Readings).
 * Query params: pump_id, entry_date (YYYY-MM-DD).
 */
exports.getLatestNozzleReadings = async (req, res) => {
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
};

/**
 * Check if today's date has any nozzle_readings for a pump (prevent duplicate daily entry).
 * Query params: pump_id, entry_date (YYYY-MM-DD).
 * Returns: { hasToday: boolean, dailyEntryId: number | null }
 */
exports.checkTodayNozzleReadings = async (req, res) => {
  try {
    const pumpId = req.query.pump_id;
    const entryDate = req.query.entry_date; // YYYY-MM-DD
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }

    const connection = await db.getConnection();

    // Step 1: find daily_sales_entry for this pump + date
    const [entryRows] = await connection.execute(
      `SELECT id FROM daily_sales_entries WHERE pump_id = ? AND entry_date = ? AND Active = 1 LIMIT 1`,
      [pumpId, entryDate]
    );

    if (!entryRows || entryRows.length === 0) {
      connection.release();
      return res.status(200).json({ hasToday: false, dailyEntryId: null });
    }

    const dailyEntryId = entryRows[0].id;

    // Step 2: check if nozzle_readings already exist for this daily_entry_id
    const [nozzleRows] = await connection.execute(
      `SELECT id FROM nozzle_readings WHERE daily_entry_id = ? LIMIT 1`,
      [dailyEntryId]
    );
    connection.release();

    if (nozzleRows && nozzleRows.length > 0) {
      return res.status(200).json({ hasToday: true, dailyEntryId });
    } else {
      return res.status(200).json({ hasToday: false, dailyEntryId });
    }
  } catch (err) {
    console.error('checkTodayNozzleReadings error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

/**
 * Get previous day's final_cash_in_hand from cash_management for a pump (for "Cash from Previous Day" in Step 4).
 * Query params: pump_id, entry_date (YYYY-MM-DD).
 */
exports.getPreviousDayCash = async (req, res) => {
  try {
    const pumpId = req.query.pump_id;
    const entryDate = req.query.entry_date; // YYYY-MM-DD
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }

    const connection = await db.getConnection();
    const [rows] = await connection.execute(
      `SELECT cm.final_cash_in_hand, cm.cash_from_previous_night
       FROM cash_management cm
       INNER JOIN daily_sales_entries dse ON cm.daily_entry_id = dse.id
       WHERE dse.pump_id = ? AND dse.entry_date < ? AND dse.Active = 1 AND (cm.Active = 1 OR cm.Active IS NULL)
       ORDER BY dse.entry_date DESC
       LIMIT 1`,
      [pumpId, entryDate]
    );
    connection.release();

    const finalCash = (rows && rows[0] && rows[0].final_cash_in_hand != null)
      ? Number(rows[0].final_cash_in_hand)
      : 0;
    const previousNight = (rows && rows[0] && rows[0].cash_from_previous_night != null)
      ? Number(rows[0].cash_from_previous_night)
      : 0;
    return res.status(200).json({ final_cash_in_hand: finalCash, cash_from_previous_night: previousNight });
  } catch (err) {
    console.error('getPreviousDayCash error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
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
    connection = await db.getConnection();
    const body = req.body || {};
    const pumpId = body.pump_id;
    const entryDate = body.entry_date; // YYYY-MM-DD
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

    await connection.beginTransaction();

    // 1. Insert or update daily_sales_entries (one per pump per date; duplicate = update so no error)
    const [entryResult] = await connection.execute(
      `INSERT INTO daily_sales_entries (pump_id, entry_date, status, submitted_at, CB, MB, cd, md, Active)
       VALUES (?, ?, 'submitted', NOW(), ?, ?, NOW(), NOW(), 1)
       ON DUPLICATE KEY UPDATE status = 'submitted', submitted_at = NOW(), CB = VALUES(CB), MB = VALUES(MB), md = NOW()`,
      [pumpId, entryDate, cb, mb]
    );
    let dailyEntryId = entryResult.insertId;
    if (!dailyEntryId) {
      const [[row]] = await connection.execute(
        `SELECT id FROM daily_sales_entries WHERE pump_id = ? AND entry_date = ? LIMIT 1`,
        [pumpId, entryDate]
      );
      if (!row || !row.id) throw new Error('Failed to create or find daily_sales_entries record');
      dailyEntryId = row.id;
      // Re-submit: remove existing child rows so we can insert fresh data
      await connection.execute('DELETE FROM nozzle_readings WHERE daily_entry_id = ?', [dailyEntryId]);
      await connection.execute('DELETE FROM machine_readings WHERE daily_entry_id = ?', [dailyEntryId]);
      await connection.execute('DELETE FROM mobile_oil_cash_sales WHERE daily_entry_id = ?', [dailyEntryId]);
      await connection.execute('DELETE FROM daily_expenses WHERE daily_entry_id = ?', [dailyEntryId]);
      // Delete cash outflow child rows first (JOIN to avoid subquery in DELETE)
      await connection.execute(
        'DELETE co FROM cash_outflow_net co INNER JOIN cash_management cm ON co.cash_management_id = cm.id WHERE cm.daily_entry_id = ?',
        [dailyEntryId]
      );
      await connection.execute(
        'DELETE co FROM cash_outflow_bank co INNER JOIN cash_management cm ON co.cash_management_id = cm.id WHERE cm.daily_entry_id = ?',
        [dailyEntryId]
      );
      await connection.execute(
        'DELETE co FROM cash_outflow_owner co INNER JOIN cash_management cm ON co.cash_management_id = cm.id WHERE cm.daily_entry_id = ?',
        [dailyEntryId]
      );
      await connection.execute('DELETE FROM cash_management WHERE daily_entry_id = ?', [dailyEntryId]);
      await connection.execute('DELETE FROM credit_sales WHERE daily_entry_id = ?', [dailyEntryId]);
      await connection.execute('DELETE FROM daily_tank_inventory WHERE daily_entry_id = ?', [dailyEntryId]);
    }

    // 2. Nozzle readings (one row per nozzle: use max of digital/mechanical sold)
    const machines = body.machines || [];
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
        const closingDigital = digital.closing ?? 0;
        const openingMechanical = mechanical.opening ?? 0;
        const closingMechanical = mechanical.closing ?? 0;
        const opening = openingDigital || openingMechanical || 0;
        const closing = closingDigital || closingMechanical || 0;
        const totalSold = Math.max(digital.sold || 0, mechanical.sold || 0);
        const salesAmount = totalSold * ratePerLiter;

        await connection.execute(
          `INSERT INTO nozzle_readings (daily_entry_id, nozzle_id, opening_digital_reading, closing_digital_reading, opening_mechanical_reading, closing_mechanical_reading, total_sold, sales_amount, cd, md, CB, MB, Active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
          [dailyEntryId, nozzleId, openingDigital, closingDigital, openingMechanical, closingMechanical, totalSold, salesAmount, cb, mb]
        );

        // Update nozzle table: set current_reading_digital/mechanical to Step-2 closing so next entry opens with these
        if (nozzleId) {
          await connection.execute(
            `UPDATE nozzles SET current_reading_digital = ?, current_reading_mechanical = ?, MB = ?, MD = NOW() WHERE id = ?`,
            [closingDigital, closingMechanical, mb, nozzleId]
          );
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

    // 4. Mobile oil cash sales
    const mobileOil = body.mobile_oil_cash_sales || {};
    if (mobileOil.liters_sold > 0 || mobileOil.total_amount > 0) {
      const litersSold = mobileOil.liters_sold ?? 0;
      const ratePerLiter = mobileOil.rate_per_liter ?? body.rates?.mobileOil ?? 0;
      const totalAmount = mobileOil.total_amount ?? litersSold * ratePerLiter;

      await connection.execute(
        `INSERT INTO mobile_oil_cash_sales (daily_entry_id, liters_sold, rate_per_liter, total_amount, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
        [dailyEntryId, litersSold, ratePerLiter, totalAmount, cb, mb]
      );
    }

    // 5. Daily expenses
    const expenses = body.expenses || [];
    for (const exp of expenses) {
      const categoryId = exp.category_id;
      const amount = exp.amount || 0;
      const description = (exp.description != null && String(exp.description).trim() !== '') ? String(exp.description).trim() : null;
      if (!categoryId || amount <= 0) continue;

      await connection.execute(
        `INSERT INTO daily_expenses (daily_entry_id, expense_category, amount, description, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
        [dailyEntryId, categoryId, amount, description, cb, mb]
      );
    }

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
      connection.release();
      return res.status(400).json({ message: 'User ID (userid) is required for shift manager_id. Please log in and try again.' });
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
    const totalCashInHand = Number(body.total_cash_in_hand) || (previousDay + otherIncome + (body.report?.totalSales || 0) - (body.report?.totalExpenses || 0));
    const cashOutflowDigital = Number(cash.cashOutflow?.digital ?? cash.cash_outflow_digital ?? 0) || 0;
    const cashOutflowBank = Number(cash.cashOutflow?.bankDeposit ?? cash.cash_outflow_bank ?? 0) || 0;
    const cashOutflowOwner = Number(cash.cashOutflow?.ownerWithdrawal ?? cash.cash_outflow_owner ?? 0) || 0;
    const totalCashOutflow = Number(body.total_cash_outflow) || (cashOutflowDigital + cashOutflowBank + cashOutflowOwner);
    const finalCashInHand = Number(body.report?.finalCash ?? 0) || 0;
    const otherIncomeDescription = (cash.otherIncomeDescription != null && String(cash.otherIncomeDescription).trim() !== '') ? String(cash.otherIncomeDescription).trim() : null;

    const [cmInsert] = await connection.execute(
      `INSERT INTO cash_management (daily_entry_id, shift_id, cash_from_previous_day, cash_from_previous_night, other_income, other_income_description, total_cash_in_hand, total_cash_outflow, final_cash_in_hand, cd, md, CB, MB, Active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
      [dailyEntryId, shiftId, previousDay, previousNight, otherIncome, otherIncomeDescription, totalCashInHand, totalCashOutflow, finalCashInHand, cb, mb]
    );
    const cashManagementId = cmInsert.insertId;

    // 8. Cash outflow child tables (CB, MB, CD, MD on all)
    // Only insert if there's actual data (amount > 0 or recipient name provided)
    const netCash = body.net_cash_withdrawal || {};
    if (cashOutflowDigital > 0 || (netCash.recipientName && netCash.recipientName.trim())) {
      await connection.execute(
        `INSERT INTO cash_outflow_net (cash_management_id, amount, recipient_name, recipient_role, reason, receipt_number, approved_by, CB, MB, CD, MD, Active)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NOW(), NOW(), 1)`,
        [
          cashManagementId,
          cashOutflowDigital,
          (netCash.recipientName || '').trim() || 'N/A',
          (netCash.recipientRole || 'Staff').trim(),
          (netCash.reason || '').trim() || null,
          (netCash.receiptReference || netCash.reiptReference || '').trim() || null,
          cb,
          mb
        ]
      );
    }

    const bankTransfer = body.bank_transfer || {};
    if (cashOutflowBank > 0 || (bankTransfer.bankName && bankTransfer.bankName.trim())) {
      await connection.execute(
        `INSERT INTO cash_outflow_bank (cash_management_id, amount, bank_name, account_title, account_number, transaction_type, transaction_ref, reason, CB, MB, CD, MD, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
        [
          cashManagementId,
          cashOutflowBank,
          (bankTransfer.bankName || '').trim() || 'N/A',
          (bankTransfer.accountTitle || '').trim() || null,
          (bankTransfer.accountNumber || '').trim() || null,
          (bankTransfer.transactionType || 'Cash Deposit').trim(),
          (bankTransfer.transactionReference || '').trim() || null,
          (bankTransfer.reason || '').trim() || null,
          cb,
          mb
        ]
      );
    }

    const ownerWithdrawal = body.owner_withdrawal || {};
    if (cashOutflowOwner > 0 || (ownerWithdrawal.personName && ownerWithdrawal.personName.trim())) {
      await connection.execute(
        `INSERT INTO cash_outflow_owner (cash_management_id, amount, person_type, person_name, purpose, notes, approved_by, CB, MB, CD, MD, Active)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NOW(), NOW(), 1)`,
        [
          cashManagementId,
          cashOutflowOwner,
          (ownerWithdrawal.personType || 'Owner').trim(),
          (ownerWithdrawal.personName || '').trim() || 'N/A',
          (ownerWithdrawal.purpose || '').trim() || null,
          (ownerWithdrawal.notes || '').trim() || null,
          cb,
          mb
        ]
      );
    }

    // 9. Credit sales
    const creditSales = body.credit_sales || [];
    for (const cs of creditSales) {
      const customerId = cs.customer_id;
      const fuelType = cs.fuelType || 'Petrol';
      const quantityLiters = cs.quantity || 0;
      const ratePerLiter = cs.priceType === 'Regular'
        ? (fuelType === 'Petrol' ? body.rates?.petrol : fuelType === 'Diesel' ? body.rates?.diesel : body.rates?.mobileOil)
        : (cs.price || 0);
      const totalAmount = cs.total ?? quantityLiters * (ratePerLiter || 0);
      const priceType = cs.priceType || 'Regular';
      const specificPrice = cs.priceType === 'Specific' ? (cs.price || 0) : null;
      const notes = cs.notes || null;
      const customerVehicleId = cs.customer_vehicle_id || null;

      await connection.execute(
        `INSERT INTO credit_sales (daily_entry_id, fuel_station_customer_id, customer_vehicle_id, fuel_type, quantity_liters, rate_per_liter, total_amount, price_type, specific_price, notes, payment_status, paid_amount, remaining_amount, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NOW(), NOW(), ?, ?, 1)`,
        [dailyEntryId, customerId, customerVehicleId, fuelType, quantityLiters, ratePerLiter || 0, totalAmount, priceType, specificPrice, notes, totalAmount, cb, mb]
      );
    }

    // 10. Daily tank inventory (optional: if payload has tank entries)
    const tankInventory = body.daily_tank_inventory || [];
    for (const ti of tankInventory) {
      await connection.execute(
        `INSERT INTO daily_tank_inventory (daily_entry_id, tank_id, opening_level, closing_level, received_quantity, sold_quantity, purchase_reference, cd, md, CB, MB, Active)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
        [
          dailyEntryId,
          ti.tank_id,
          ti.opening_level ?? 0,
          ti.closing_level ?? 0,
          ti.received_quantity ?? 0,
          ti.sold_quantity ?? 0,
          ti.purchase_reference ?? null,
          cb,
          mb
        ]
      );
    }

    await connection.commit();
    connection.release();

    return res.status(200).json({
      message: 'Daily report submitted successfully',
      daily_entry_id: dailyEntryId
    });
  } catch (err) {
    if (connection) {
      try { await connection.rollback(); } catch (_) { }
      connection.release();
    }
    // Duplicate entry: one daily entry per pump per date (unique_daily_entry)
    const isDuplicate = err.code === 'ER_DUP_ENTRY' || (err.sqlState === '23000' && /Duplicate entry/.test(err.sqlMessage || ''));
    if (isDuplicate) {
      return res.status(409).json({
        message: 'A daily sales entry for this pump and date already exists. Please edit the existing entry or choose a different date.',
        code: 'DUPLICATE_ENTRY'
      });
    }
    console.error('submitDailyEntry error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

/**
 * Get nozzle readings for a specific date from a pump
 * Query params: pump_id, entry_date (can be YYYY-MM-DD, DD/MM/YYYY, or ISO string)
 */
exports.getNozzleReadingsByDate = async (req, res) => {
  try {
    let pumpId = req.query.pump_id;
    let entryDate = req.query.entry_date; // Can be various formats
    if (!pumpId || !entryDate) {
      return res.status(400).json({ message: 'pump_id and entry_date are required' });
    }

    // Ensure pumpId is an integer
    pumpId = parseInt(pumpId, 10);

    // Normalize date format to YYYY-MM-DD
    entryDate = normalizeDateFormat(entryDate);
    console.log('getNozzleReadingsByDate - pumpId:', pumpId, 'entryDate (normalized):', entryDate);

    const connection = await db.getConnection();

    // First, check if there's a daily entry for the specified date
    const [dailyEntries] = await connection.execute(
      `SELECT dse.id, dse.cd
       FROM daily_sales_entries dse
       WHERE dse.pump_id = ? AND CAST(dse.entry_date AS DATE) = CAST(? AS DATE) AND dse.Active = 1
       LIMIT 1`,
      [pumpId, entryDate]
    );
    //console.log('getNozzleReadingsByDate dailyEntries:', dailyEntries);

    // If no daily entry exists for this date, return empty machines
    if (!dailyEntries || dailyEntries.length === 0) {
      console.log('getNozzleReadingsByDate: No daily entry found for date:', entryDate);
      connection.release();
      return res.status(200).json({ machines: [], dailyEntryId: null, cdDateTime: null });
    }

    // Get the daily entry ID and CD datetime
    const dailyEntryId = dailyEntries[0].id;
    const cdDateTime = dailyEntries[0].cd;

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
      connection.release();
      return res.status(200).json({ machines: [] });
    }

    // Get nozzle readings for the daily entry (we already confirmed it exists)
    let readings = [];
    const [readingsData] = await connection.execute(
      `SELECT nozzle_id, opening_digital_reading, opening_mechanical_reading, 
              closing_digital_reading, closing_mechanical_reading
       FROM nozzle_readings
       WHERE daily_entry_id = ? AND Active = 1`,
      [dailyEntryId]
    );
    readings = readingsData;
    //console.log('getNozzleReadingsByDate readings:', readings);
    connection.release();

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

      // Find reading for this nozzle from nozzle_readings table
      const reading = readings.find(r => r.nozzle_id === row.nozzle_id);

      // If we have a reading from nozzle_readings, use it; otherwise fall back to nozzles table current readings
      machinesMap[row.machine_id].nozzles.push({
        id: row.nozzle_id,
        name: `Nozzle ${row.nozzle_number}`,
        oldDigital: reading
          ? (reading.opening_digital_reading != null ? Number(reading.opening_digital_reading) : null)
          : (row.initial_reading_digital != null ? Number(row.initial_reading_digital) : null),
        newDigital: reading
          ? (reading.closing_digital_reading != null ? Number(reading.closing_digital_reading) : null)
          : (row.current_reading_digital != null ? Number(row.current_reading_digital) : null),
        oldMech: reading
          ? (reading.opening_mechanical_reading != null ? Number(reading.opening_mechanical_reading) : null)
          : (row.initial_reading_mechanical != null ? Number(row.initial_reading_mechanical) : null),
        newMech: reading
          ? (reading.closing_mechanical_reading != null ? Number(reading.closing_mechanical_reading) : null)
          : (row.current_reading_mechanical != null ? Number(row.current_reading_mechanical) : null),
        isEditing: false
      });
    });

    const machines = Object.values(machinesMap);
    return res.status(200).json({
      machines,
      dailyEntryId: dailyEntryId,
      cdDateTime: cdDateTime
    });
  } catch (err) {
    console.error('getNozzleReadingsByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

/**
 * Update nozzle readings for a daily entry
 */
exports.updateNozzleReadings = async (req, res) => {
  try {
    const { daily_entry_id, readings } = req.body;

    if (!daily_entry_id || !readings || !Array.isArray(readings)) {
      return res.status(400).json({ message: 'daily_entry_id and readings array are required' });
    }

    //console.log('updateNozzleReadings - daily_entry_id:', daily_entry_id);
    //console.log('updateNozzleReadings - readings count:', readings.length);

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // Update each nozzle reading
      for (const reading of readings) {
        const { nozzle_id, opening_digital_reading, closing_digital_reading, opening_mechanical_reading, closing_mechanical_reading } = reading;

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
                 md = NOW()
             WHERE id = ?`,
            [opening_digital_reading, closing_digital_reading, opening_mechanical_reading, closing_mechanical_reading, existingReading[0].id]
          );
        } else {
          // Insert new reading (shouldn't happen normally but handle it)
          await connection.execute(
            `INSERT INTO nozzle_readings 
             (daily_entry_id, nozzle_id, opening_digital_reading, closing_digital_reading, 
              opening_mechanical_reading, closing_mechanical_reading, cd, md, Active) 
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW(), 1)`,
            [daily_entry_id, nozzle_id, opening_digital_reading, closing_digital_reading,
              opening_mechanical_reading, closing_mechanical_reading]
          );
        }
      }

      // Update the MD (modified date) of the daily sales entry
      await connection.execute(
        `UPDATE daily_sales_entries SET md = NOW() WHERE id = ?`,
        [daily_entry_id]
      );

      await connection.commit();
      connection.release();

      //console.log('updateNozzleReadings: Successfully updated readings');
      return res.status(200).json({ message: 'Nozzle readings updated successfully' });

    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }

  } catch (err) {
    console.error('updateNozzleReadings error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

// Get expenses by date
exports.getExpensesByDate = async (req, res) => {
  try {
    console.log('getExpensesByDate: Start');
    const { date } = req.query;
    const pumpId = req.body.pumpId || 1;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }

    console.log('getExpensesByDate: Looking for date', date, 'pumpId', pumpId);

    const normalizedDate = normalizeDateFormat(date);

    // First check if a daily sales entry exists for this date
    const [entries] = await db.execute(
      `SELECT id, CD 
       FROM daily_sales_entries 
       WHERE pump_id = ? AND DATE(entry_date) = ? AND Active = 1 
       LIMIT 1`,
      [pumpId, normalizedDate]
    );

    if (entries.length === 0) {
      console.log('getExpensesByDate: No daily entry found for this date');
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        expenses: []
      });
    }

    const dailyEntryId = entries[0].id;
    const cdDateTime = entries[0].CD;

    console.log('getExpensesByDate: Daily entry found', dailyEntryId, 'CD:', cdDateTime);

    // Get expenses for this daily entry with category names
    const [expenses] = await db.execute(
      `SELECT 
        de.id,
        de.expense_category as categoryId,
        COALESCE(ec.name, 'Other') as categoryName,
        de.amount,
        de.description
       FROM daily_expenses de
       LEFT JOIN expense_categories ec ON de.expense_category = ec.id
       WHERE de.daily_entry_id = ? AND de.Active = 1
       ORDER BY de.id ASC`,
      [dailyEntryId]
    );

    console.log('getExpensesByDate: Found', expenses.length, 'expenses');

    return res.status(200).json({
      dailyEntryId,
      cdDateTime,
      expenses: expenses.map(exp => ({
        id: exp.id,
        categoryId: exp.categoryId,
        categoryName: exp.categoryName,
        amount: parseFloat(exp.amount || 0),
        description: exp.description
      }))
    });

  } catch (err) {
    console.error('getExpensesByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

// Update expenses
exports.updateExpenses = async (req, res) => {
  try {
    console.log('updateExpenses: Start');
    const { daily_entry_id, expenses } = req.body;

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    if (!Array.isArray(expenses)) {
      return res.status(400).json({ message: 'Expenses must be an array' });
    }

    const db = require('../models/db');
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      console.log('updateExpenses: Updating', expenses.length, 'expenses for daily entry', daily_entry_id);

      // Update each expense
      for (const expense of expenses) {
        if (!expense.id) continue;

        await connection.execute(
          `UPDATE daily_expenses 
           SET amount = ?, 
               description = ?,
               MD = NOW()
           WHERE id = ? AND daily_entry_id = ? AND Active = 1`,
          [
            expense.amount || 0,
            expense.description || null,
            expense.id,
            daily_entry_id
          ]
        );
      }

      await connection.commit();
      connection.release();

      console.log('updateExpenses: Successfully updated expenses');
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

// Get expense categories
exports.getExpenseCategories = async (req, res) => {
  try {
    console.log('getExpenseCategories: Start');

    // First try to get BUSINESS type categories
    const [categories] = await db.execute(
      `SELECT id, name 
       FROM expense_categories 
       WHERE Active = 1 AND expense_type = 'BUSINESS'
       ORDER BY name ASC`
    );

    console.log('getExpenseCategories: Found', categories.length, 'BUSINESS categories');

    // If no categories found, try to get all active categories as fallback
    if (categories.length === 0) {
      console.log('getExpenseCategories: No BUSINESS categories found, trying all active categories...');
      const [allCategories] = await db.execute(
        `SELECT id, name 
         FROM expense_categories 
         WHERE Active = 1
         ORDER BY name ASC`
      );
      console.log('getExpenseCategories: Found', allCategories.length, 'total active categories');

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
  }
};

// Save expenses (update existing + create new)
exports.saveExpenses = async (req, res) => {
  try {
    console.log('saveExpenses: Start');
    const { daily_entry_id, existing_expenses, new_expenses, current_user } = req.body;
    const createdBy = current_user || 'System';

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      console.log('saveExpenses: Updating', existing_expenses?.length || 0, 'existing expenses');
      console.log('saveExpenses: Creating', new_expenses?.length || 0, 'new expenses');

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
             WHERE id = ? AND daily_entry_id = ? AND Active = 1`,
            [
              expense.amount || 0,
              expense.description || null,
              createdBy,
              expense.id,
              daily_entry_id
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
             (daily_entry_id, expense_category, amount, description, cd, md, CB, MB, Active)
             VALUES (?, ?, ?, ?, NOW(), NOW(), ?, ?, 1)`,
            [
              daily_entry_id,
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

      console.log('saveExpenses: Successfully saved all expenses');
      return res.status(200).json({ message: 'Expenses saved successfully' });

    } catch (err) {
      await connection.rollback();
      connection.release();
      throw err;
    }

  } catch (err) {
    console.error('saveExpenses error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

// Get credit sales by date
exports.getCreditSalesByDate = async (req, res) => {
  try {
    console.log('getCreditSalesByDate: Start');
    const { pump_id, date } = req.query;

    if (!pump_id || !date) {
      return res.status(400).json({ message: 'Pump ID and date are required' });
    }

    const formattedDate = normalizeDateFormat(date);
    console.log('getCreditSalesByDate: pump_id:', pump_id, 'date:', formattedDate);

    // First check if daily sales entry exists for this date
    const [dailyEntryRows] = await db.execute(
      `SELECT id, CD as cdDateTime 
       FROM daily_sales_entries 
       WHERE pump_id = ? AND entry_date = ? AND Active = 1 
       LIMIT 1`,
      [pump_id, formattedDate]
    );

    if (dailyEntryRows.length === 0) {
      console.log('getCreditSalesByDate: No daily entry found');
      return res.status(200).json({
        dailyEntryId: null,
        cdDateTime: null,
        creditSales: []
      });
    }

    const dailyEntryId = dailyEntryRows[0].id;
    const cdDateTime = dailyEntryRows[0].cdDateTime;

    console.log('getCreditSalesByDate: Found daily entry ID:', dailyEntryId, 'CD:', cdDateTime);

    // Get credit sales for this daily entry with customer, vehicle, and fuel type names
    const [creditSalesRows] = await db.execute(
      `SELECT 
        cs.id,
        cs.fuel_station_customer_id as customerId,
        fsc.customer_name as customerName,
        cs.customer_vehicle_id as customerVehicleId,
        fscv.vehicle_number as vehicleNumber,
        COALESCE(ft.id, cs.fuel_type) as fuelTypeId,
        cs.quantity_liters as quantity,
        cs.price_type as priceType,
        cs.rate_per_liter as ratePerLiter,
        cs.total_amount as totalAmount,
        cs.notes,
        COALESCE(ft.name, cs.fuel_type) as fuelTypeName
       FROM credit_sales cs 
       LEFT JOIN fuel_station_customer fsc ON cs.fuel_station_customer_id = fsc.customer_id
       LEFT JOIN fuele_station_customer_vehicles fscv ON cs.customer_vehicle_id = fscv.vehicle_id
       LEFT JOIN fuel_types ft ON CAST(cs.fuel_type AS UNSIGNED) = ft.id OR LOWER(ft.name) = LOWER(cs.fuel_type)
       WHERE cs.daily_entry_id = ? AND cs.Active = 1
       ORDER BY cs.id`,
      [dailyEntryId]
    );

    console.log('getCreditSalesByDate: Found', creditSalesRows.length, 'credit sales');

    return res.status(200).json({
      dailyEntryId: dailyEntryId,
      cdDateTime: cdDateTime,
      creditSales: creditSalesRows
    });

  } catch (err) {
    console.error('getCreditSalesByDate error:', err);
    return res.status(500).json({ message: 'Server Error', error: err.message });
  }
};

// Save credit sales (update existing + create new)
exports.saveCreditSales = async (req, res) => {
  try {
    console.log('saveCreditSales: Start');
    const { daily_entry_id, existing_sales, new_sales, current_user } = req.body;
    const createdBy = current_user || 'System';

    console.log('saveCreditSales: Received new_sales:', JSON.stringify(new_sales, null, 2));

    if (!daily_entry_id) {
      return res.status(400).json({ message: 'Daily entry ID is required' });
    }

    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      console.log('saveCreditSales: Updating', existing_sales?.length || 0, 'existing sales');
      console.log('saveCreditSales: Creating', new_sales?.length || 0, 'new sales');

      // Update existing credit sales
      if (Array.isArray(existing_sales) && existing_sales.length > 0) {
        for (const sale of existing_sales) {
          if (!sale.id) continue;

          console.log('saveCreditSales: Updating existing sale ID', sale.id,
            'with:', { customerId: sale.customerId, vehicleId: sale.customerVehicleId, fuelTypeId: sale.fuelTypeId });

          await connection.execute(
            `UPDATE credit_sales 
             SET fuel_station_customer_id = ?,
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
              sale.customerId || null,
              sale.customerVehicleId || null,
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
          if (!sale.customerId || !sale.fuelTypeId || sale.quantity <= 0) continue;

          console.log('saveCreditSales: Inserting new sale:',
            { customerId: sale.customerId, vehicleId: sale.customerVehicleId, fuelTypeId: sale.fuelTypeId, qty: sale.quantity });

          await connection.execute(
            `INSERT INTO credit_sales 
             (daily_entry_id, fuel_station_customer_id, customer_vehicle_id, fuel_type, quantity_liters, rate_per_liter, 
              total_amount, price_type, specific_price, notes, payment_status, paid_amount, 
              remaining_amount, cd, md, CB, MB, Active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NOW(), NOW(), ?, ?, 1)`,
            [
              daily_entry_id,
              sale.customerId,
              sale.customerVehicleId || null,
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

      console.log('saveCreditSales: Successfully saved all credit sales');
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


