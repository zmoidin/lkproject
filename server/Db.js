// GETTING POOL INSTANCE SO WE CAN SEND QUERIES TO CONNECTION POOL. MORE INFO IS ON POOL.JS
const pool = require("./pool");
const mysql = require("mysql");

// EXPORTING DB MODULE SO WE CAN USE IT IN MAIN APP CLASS.
module.exports = function Db()
{
	console.log("db class");
	
	// FUNCTION TO INSERT DATA INTO DATABASE.
	Db.prototype.insert = function(table, data)
	{
		if(data)
		{
			return new Promise((resolve, reject) =>
			{
				let queryRaw = "INSERT INTO `"+table+"` SET ?";
				let query = mysql.format(queryRaw, data);
				pool.query(query,(err, result)=>
				{
					console.log(query);
					if (err)
					{
						reject(err);
					}
					else
					{
						resolve(result);
					}
				})
			});
		}
		else
		{
			console.log("No data was submited to insert into database");
		}
	}
	
	// FUNCTION TO UPDAte DATA INTO DATABASE.
	Db.prototype.update = function(table, data, where)
	{
		if(data)
		{
			return new Promise((resolve, reject) =>
			{
				let queryRaw = "UPDATE `"+table+"` SET ? " + where;
				let query = mysql.format(queryRaw, data);
				console.log(query);
				pool.query(query,(err, result)=>
				{
					if (err)
					{
						reject(err);
					}
					else
					{
						resolve(result);
					}
				})
			});
		}
		else
		{
			console.log("No data was submited to update database");
		}
	}
	
	// EXECUTE A QUERY ON DATABASE
	Db.prototype.execute = function(query)
	{
		return new Promise((resolve, reject) =>
		{
			pool.query(query,(err, result, fields)=>
			{
				if (err)
				{
					reject(err);
				}
				else
				{
					resolve(result);
				}
			});
		});
	}
	
	// GETTING ROWS FROM DATABASE
	Db.prototype.getRows = function(query)
	{
		return new Promise((resolve, reject) =>
		{
			pool.query(query,(err, result, fields)=>
			{
				if (err)
				{
					reject(err);
				}
				else
				{
					resolve(result);
				}
			})
		});
	}
	
	Db.prototype.getArray = async function(query, col)
	{
		this.getRows(query).then(rows =>
		{
			let data = [];
			rows.forEach(row=>
			{
				data.push(row[col]);
			});
			return data;
		});
	}
	
	// GETTING SINGLE ROW FROM DATABASE
	Db.prototype.getRow = function(query)
	{
		return new Promise((resolve, reject) =>
		{
			pool.query(query,(err, result, fields)=>
			{
				if (err)
				{
					reject(err);
				}
				else
				{
					if(result.length > 0)
					{
						result = result[0];
					}
					else
					{
						result = 0;
					}
					// console.log("result getRow ", result);
					resolve(result);
				}
			})
		});
	}
	
	// GETTING SINGLE VALUE FROM DATABASE
	Db.prototype.getValue = function(query)
	{
		return new Promise((resolve, reject) =>
		{
			try
			{
				pool.query (query, (err, result, fields) =>
				{
					if (err)
					{
						reject (err);
					} else
					{
						if (result.length > 0)
						{
							result = result[0];
							result = Object.values (result)[0];
						} else
						{
							result = 0;
						}
						console.log ("resul getValue ", result);
						resolve (result);
					}
				});
			}
			catch (e)
			{
				console.log("DB Query Failed, ",e);
				reject(e);
			}
			});
	}
}
//dd
