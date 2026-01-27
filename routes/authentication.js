const express = require('express');
const router = express.Router();
const dataController = require('../controllers/datacontroller');
const projectController = require('../controllers/projectcontroller');
const tripsController = require('../controllers/tripscontroller');
const customersController = require('../controllers/customerscontroller');
const driversController = require('../controllers/driverscontroller');
const deposController = require('../controllers/deposcontroller');
const poolController = require('../controllers/poolcontroller');
const bankMgmtController = require('../controllers/bankcontroller');
const accountController = require('../controllers/accountcontroller');
const transactionController = require('../controllers/transactioncontroller');
const cashInHandController = require('../controllers/cashinhandcontroller');
const vehicleRentController = require('../controllers/vehiclerentcontroller');
const vehicleExpensesController = require('../controllers/vehicleexpensescontroller');
const vehicleExpenseTypeController = require('../controllers/vehicleexpensetypecontroller');
const recoveriesController = require('../controllers/recoveriescontroller');
const expenseCategoriesController = require('../controllers/expensecategoriescontroller');
const expensesController = require('../controllers/expensescontroller');
const companyController = require('../controllers/companycontroller');
const pickUpLocationController = require('../controllers/pickuplocationcontroller');
const stationsController = require('../controllers/stationscontroller');
const fuelTypesController = require('../controllers/fueltypescontroller');
const metersController = require('../controllers/meterscontroller');
const meterReadingsController = require('../controllers/meterreadingscontroller');
const fuelRatesController = require('../controllers/fuelratescontroller');
const dailySalesSummaryController = require('../controllers/dailysalessummarycontroller');

// Authentication
router.post('/login', dataController.login);
router.post('/signup', dataController.signup);
router.get('/getAlowedModules', dataController.getAlowedModules);
router.get('/getCurrentUser', dataController.getCurrentUser);

// Dashboard
router.get('/getDashboardData', projectController.getDashboardData);
router.get('/getPendingTrips', projectController.getPendingTrips);
router.get('/getCreditTrips', projectController.getCreditTrips);

// Trips
router.get('/getTrips', tripsController.getTrips);
router.get('/getTrip', tripsController.getTrip);
router.post('/addTrip', tripsController.addTrip);
router.post('/updateTrip', tripsController.updateTrip);
router.delete('/deleteTrip', tripsController.deleteTrip);
router.get('/getClients', tripsController.getClients);
router.get('/getLicenseHolders', tripsController.getLicenseHolders);
router.get('/getVehicles', tripsController.getVehicles);
router.get('/getPetrolPumps', tripsController.getPetrolPumps);
router.post('/addVehicle', tripsController.addVehicle);
router.post('/updateVehicle', tripsController.updateVehicle);
router.delete('/deleteVehicle', tripsController.deleteVehicle);
router.post('/addLicenseHolder', tripsController.addLicenseHolder);
router.post('/updateLicenseHolder', tripsController.updateLicenseHolder);
router.delete('/deleteLicenseHolder', tripsController.deleteLicenseHolder);
router.get('/getSoldFuelForTrip', tripsController.getSoldFuelForTrip);
router.get('/getTripDistribution', tripsController.getTripDistribution);
router.get('/getTodayPolSales', tripsController.getTodayPolSales);
router.get('/getTripProducts', tripsController.getTripProducts);
router.get('/getTripProductDetails', tripsController.getTripProductDetails);
router.post('/addSale', tripsController.addSale);

// Vehicle Rent
router.get('/getVehicleRents', vehicleRentController.getVehicleRents);
router.get('/getVehicleRent/:id', vehicleRentController.getVehicleRentById);
router.get('/getVehicleRentByTrip/:tripId', vehicleRentController.getVehicleRentByTripId);
router.get('/getVehicleRentTransactions', vehicleRentController.getVehicleRentTransactions);
router.post('/addVehicleRent', vehicleRentController.addVehicleRent);
router.put('/updateVehicleRent', vehicleRentController.updateVehicleRent);
router.delete('/deleteVehicleRent/:id', vehicleRentController.deleteVehicleRent);

// Vehicle Expenses
router.get('/getVehicleExpenses', vehicleExpensesController.getVehicleExpenses);
router.get('/getVehicleTotalExpenses', vehicleExpensesController.getVehicleTotalExpenses);
router.get('/getAllVehiclesTotalExpenses', vehicleExpensesController.getAllVehiclesTotalExpenses);
router.post('/addVehicleExpense', vehicleExpensesController.addVehicleExpense);
router.delete('/deleteVehicleExpense', vehicleExpensesController.deleteVehicleExpense);

// Vehicle Expense Types
router.get('/getVehicleExpenseTypes', vehicleExpenseTypeController.getVehicleExpenseTypes);
router.post('/addVehicleExpenseType', vehicleExpenseTypeController.addVehicleExpenseType);
router.put('/updateVehicleExpenseType', vehicleExpenseTypeController.updateVehicleExpenseType);
router.delete('/deleteVehicleExpenseType', vehicleExpenseTypeController.deleteVehicleExpenseType);

// Customers
router.get('/getCustomers', customersController.getCustomers);
router.get('/getCustomer', customersController.getCustomer);
router.get('/getCustomerSales', customersController.getCustomerSales);
router.get('/getCustomerPayments', customersController.getCustomerPayments);
router.get('/getCustomersDueAmounts', customersController.getCustomersDueAmounts);
router.post('/addCustomer', customersController.addCustomer);
router.post('/updateCustomer', customersController.updateCustomer);
router.delete('/deleteCustomer', customersController.deleteCustomer);

// Drivers
router.get('/getDrivers', driversController.getDrivers);
router.get('/getDriver', driversController.getDriver);
router.post('/addDriver', driversController.addDriver);
router.post('/updateDriver', driversController.updateDriver);
router.delete('/deleteDriver', driversController.deleteDriver);

// Depos
router.get('/getDepos', deposController.getDepos);
router.get('/getDepo', deposController.getDepo);
router.get('/checkDepoUsedInTrips', deposController.checkDepoUsedInTrips);
router.post('/addDepo', deposController.addDepo);
router.post('/updateDepo', deposController.updateDepo);
router.delete('/deleteDepo', deposController.deleteDepo);

// Pool
router.get('/getPools', poolController.getPools);
router.get('/getPool', poolController.getPool);
router.get('/getPoolHistory', poolController.getPoolHistory);
router.post('/addPool', poolController.addPool);
router.post('/updatePool', poolController.updatePool);
router.delete('/deletePool', poolController.deletePool);

// Bank Management
router.get('/getBanks', bankMgmtController.getBanks);
router.get('/getBank', bankMgmtController.getBank);
router.post('/addBank', bankMgmtController.addBank);
router.post('/updateBank', bankMgmtController.updateBank);
router.delete('/deleteBank', bankMgmtController.deleteBank);

// Account Management
router.get('/getAccounts', accountController.getAccounts);
router.get('/getAccount', accountController.getAccount);
router.post('/addAccount', accountController.addAccount);
router.post('/updateAccount', accountController.updateAccount);
router.delete('/deleteAccount', accountController.deleteAccount);
router.post('/accounts/:id/qr', accountController.uploadQrCodeMiddleware, accountController.uploadQrCode);

// Transaction Management
router.post('/addPayment', transactionController.addPayment);
router.post('/addCashInHandPayment', transactionController.addCashInHandPayment);
router.post('/addAccountTransaction', transactionController.addAccountTransaction);
router.get('/getTransactions', transactionController.getTransactions);
router.get('/getTransactionsByAccount', transactionController.getTransactionsByAccount);
router.get('/getPayments', transactionController.getPayments);
router.get('/getTripsWithRemaining', transactionController.getTripsWithRemaining);
router.get('/getDepoRemainingAmount', tripsController.getDepoRemainingAmount);

// Cash in Hand Management
router.get('/getCashInHand', cashInHandController.getCashInHand);
router.get('/getCashAccounts', cashInHandController.getCashAccounts);
router.get('/getCashInHandBalance', cashInHandController.getCashInHandBalance);
router.get('/getCashInHandByDate', cashInHandController.getCashInHandByDate);
router.get('/getCashInHandHistoryByDate', cashInHandController.getCashInHandHistoryByDate);
router.get('/checkCashInHandReferences', cashInHandController.checkCashInHandReferences);
router.post('/addCashInHand', cashInHandController.addCashInHand);
router.post('/updateCashInHand', cashInHandController.updateCashInHand);
router.post('/transferToBank', cashInHandController.transferToBank);
router.delete('/deleteCashInHand', cashInHandController.deleteCashInHand);

// Recoveries Management
router.get('/getRecoveries', recoveriesController.getRecoveries);
router.get('/getRecovery', recoveriesController.getRecovery);
router.post('/addRecovery', recoveriesController.addRecovery);
router.delete('/deleteRecovery', recoveriesController.deleteRecovery);

// Expense Categories Management
router.get('/getExpenseCategories', expenseCategoriesController.getExpenseCategories);
router.get('/getExpenseCategory', expenseCategoriesController.getExpenseCategory);
router.post('/addExpenseCategory', expenseCategoriesController.addExpenseCategory);
router.post('/updateExpenseCategory', expenseCategoriesController.updateExpenseCategory);
router.delete('/deleteExpenseCategory', expenseCategoriesController.deleteExpenseCategory);

// Expenses Management
router.get('/getExpenses', expensesController.getExpenses);
router.get('/getExpense', expensesController.getExpense);
router.get('/getTotalExpenses', expensesController.getTotalExpenses);
router.post('/addExpense', expensesController.addExpense);
router.post('/updateExpense', expensesController.updateExpense);
router.delete('/deleteExpense', expensesController.deleteExpense);

// Company Management
router.get('/getCompanies', companyController.getCompanies);
router.get('/getCompany', companyController.getCompany);
router.post('/addCompany', companyController.addCompany);
router.post('/updateCompany', companyController.updateCompany);
router.delete('/deleteCompany', companyController.deleteCompany);

// Pick Up Location Management
router.get('/getPickUpLocations', pickUpLocationController.getPickUpLocations);
router.get('/getPickUpLocation', pickUpLocationController.getPickUpLocation);
router.post('/addPickUpLocation', pickUpLocationController.addPickUpLocation);
router.post('/updatePickUpLocation', pickUpLocationController.updatePickUpLocation);
router.delete('/deletePickUpLocation', pickUpLocationController.deletePickUpLocation);

// Stations
router.get('/getStations', stationsController.getStations);
router.get('/getStation', stationsController.getStation);
router.post('/addStation', stationsController.addStation);
router.post('/updateStation', stationsController.updateStation);
router.delete('/deleteStation', stationsController.deleteStation);

// Fuel Types
router.get('/getFuelTypes', fuelTypesController.getFuelTypes);
router.get('/getFuelType', fuelTypesController.getFuelType);
router.post('/addFuelType', fuelTypesController.addFuelType);
router.post('/updateFuelType', fuelTypesController.updateFuelType);
router.delete('/deleteFuelType', fuelTypesController.deleteFuelType);

// Meters
router.get('/getMeters', metersController.getMeters);
router.get('/getMeter', metersController.getMeter);
router.post('/addMeter', metersController.addMeter);
router.post('/updateMeter', metersController.updateMeter);
router.delete('/deleteMeter', metersController.deleteMeter);

// Meter Readings
router.get('/getMeterReadings', meterReadingsController.getMeterReadings);
router.get('/getMeterReading', meterReadingsController.getMeterReading);
router.post('/addMeterReading', meterReadingsController.addMeterReading);
router.post('/updateMeterReading', meterReadingsController.updateMeterReading);
router.delete('/deleteMeterReading', meterReadingsController.deleteMeterReading);

// Fuel Rates
router.get('/getFuelRates', fuelRatesController.getFuelRates);
router.get('/getFuelRate', fuelRatesController.getFuelRate);
router.get('/getCurrentFuelRate', fuelRatesController.getCurrentFuelRate);
router.post('/addFuelRate', fuelRatesController.addFuelRate);
router.post('/updateFuelRate', fuelRatesController.updateFuelRate);
router.delete('/deleteFuelRate', fuelRatesController.deleteFuelRate);

// Daily Sales Summary
router.get('/getDailySalesSummaries', dailySalesSummaryController.getDailySalesSummaries);
router.get('/getDailySalesSummary', dailySalesSummaryController.getDailySalesSummary);
router.post('/addDailySalesSummary', dailySalesSummaryController.addDailySalesSummary);
router.post('/updateDailySalesSummary', dailySalesSummaryController.updateDailySalesSummary);
router.delete('/deleteDailySalesSummary', dailySalesSummaryController.deleteDailySalesSummary);

module.exports = router;
