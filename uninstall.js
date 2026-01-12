var Service=require('node-windows').Service;

var svc=new Service({
	name:'Novita Admin',
	description:'Node.js server.',
	script:'E:\\NOVITA Builders\\NovitaERP\\nodejs-express-mysql\\index.js'
});

svc.on('uninstall',function(){

	console.log('Uninstall Completeed');
});

svc.uninstall();