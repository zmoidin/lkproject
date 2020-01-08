const mysql = require('mysql');
const util = require('util');
require ('dotenv').config ();

console.log("running pool");
var pool = mysql.createPool (
{
	connectionLimit: process.env.connectionLimit,
	host: process.env.mysqlhost,
	user: process.env.mysqluser,
	password: process.env.mysqlpass,
	database: process.env.mysqldb,
	port: process.env.mysqlport,
	//waitForConnections: false,
	//debug: true
});
pool.getConnection(function(err, connection)
{
	console.log("getting db connection")
	if (err)
	{
		if (err.code === 'PROTOCOL_CONNECTION_LOST')
		{
			console.error('Database connection was closed.')
		}
		if (err.code === 'ER_CON_COUNT_ERROR')
		{
			console.error('Database has too many connections.')
		}
		if (err.code === 'ECONNREFUSED')
		{
			console.error('Database connection was refused.')
		}
		console.log("Error in db connection ", err);
	}
	if (connection)
	{
		console.log("releasing db connection");
		connection.release()
	}
	return
});
pool.query = util.promisify(pool.query);
module.exports = pool;
