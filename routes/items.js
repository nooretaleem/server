const express = require('express');
const router = express.Router();
const itemsController = require('../controllers/itemscontroller');

//router.get('/getData', dataController.getData);
//router.post('/addData', dataController.addData);

//Items
router.get('/getItems', itemsController.getItems);
router.post('/addItems', itemsController.addItems);
//console.log('Exposing the following endpoints:', router);
module.exports = router;
