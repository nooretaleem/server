const db=require('../util/database');


module.exports=class User{
    constructor(name,email,password){
        this.name=name;
        this.email=email;
        this.password=password;
    }
    
  // Save user to database
  static save(user) {
    return db.execute(
        'INSERT INTO users (name, email, password) VALUES (?,?,?)',
        [user.name,user.email.user.password]

        );
      }

  // Find user by email
  static find(email) {
    return db.execute('Select * from users where email=?', [email]);
  }
};

