const mysql=require('mysql2');

const config=require('../config/config.json');
const connection=mysql.createConnection({
  host:config.host,
  user:config.user,
  password:config.password,
  database:config.database
});
const connect=()=>{
  return new Promise((resolve,reject)=>{
    connection.connect((error)=>{
      if(error){
        reject(error);

      }
      else{
        resolve('Database connected succesfully.');
      }
    });
  });
};

module.exports={
connect:connect,
connection:connection
};