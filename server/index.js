const history = require('connect-history-api-fallback');
const express = require ('express');
require ('dotenv').config ();
const app = express ();
const https = require ("https"), http = require ("http");
const fs = require ("fs");
const path = require('path');
const dbClass = require('./Db');
const crypto = require('crypto');
const os 	= require('os-utils');
const mediasoup = require("mediasoup");
const requestIp = require('request-ip');
const compression = require('compression')
const fileUpload = require ('express-fileupload');
const download = require ('./download');
const Db = new dbClass();
let questionsArray = [];
let roomMembers = new Array ();
let roomChats = new Array();
let privateRoomChats = new Array();
let diagnostics = new Array();
let buttonIC;
let buttonICs = [];

// WE WILL STORE STATE IF WE ARE SERVING A ROOM MEMBER. SO WE CAN IMPLEMENT QUEUE MECHANISM TO AVAOID SERVING SAME
// DATA TO 2 PARTICIPANTS.
let serving = [];

// VARIABLES FOR MEDIASOUP SERVER.
let consumerTransports = {};
let videoConsumers = {};
let audioConsumers = {};
let screenConsumers = {};
let producerTransports = {};
let videoProducers = {};
let audioProducers = {};
let screenProducers = {};
let worker = null;
let router = null;

// VARIABLE TO STORE ROOM SETTINGS/STATES, THESE WILL BE SENT TO ROOM WHEN NEW USER JOINS IN.
let roomSettings = new Array();
let hostSocket;
let roomHostsSockets = [];
let siteVariables = [];

if (process.env.mode == 'development')
{
	var server = http.createServer (app);
	console.log("running in development mode on port : " + process.env.port );
}
else
{
	console.log("running in production mode on port : " + process.env.port );
	// GETTING SSL FILE AND ADDING IT TO SERVER.
	var options =
	{
		key: fs.readFileSync ("ssl/server.key"),
		cert: fs.readFileSync ("ssl/server.crt")
	};
	var server = https.createServer (options, app);
}

const io = require('socket.io')(server,
{
	// BELOW ARE ENGINE.IO OPTIONS
	pingInterval: 10000,
	pingTimeout: 30000,
});

// const io = require ('socket.io').listen (server)
// io.set('heartbeat timeout', 30000);
// io.set('heartbeat interval', 3000);

// ADDING GZIP COMPRESSION TO REDUCE THE DOWNLOAD SIZE OF FILES.
app.use(compression({
}));

// ENABLE FILES UPLOAD
app.use (fileUpload ({
	createParentPath: true
}));

// ENABLING REWRITE MODE.
app.use(history(
{
	verbose: false
}));
app.use (express.static ('../client/dist'));

// CODE SECTION TO DEAL WITH FILE UPLOAD
let speedTestDir = "./uploads/speed-test";
const bodyParser = require("body-parser");
const multipart = require('connect-multiparty');
const multipartMiddleware = multipart({
	uploadDir: speedTestDir
});

app.use( bodyParser.json() );
app.use( bodyParser.urlencoded({
	extended: true
}));
app.use(requestIp.mw());

app.use(function(req, res, next)
{
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Headers", "*");
	next();
});

// GETTING THE ICONS/BUTTONS FROM BUTTON IC TABLE. WE WILL SEND THIS INFORMATION TO ROOM WHEN USER SENDS A REQUEST
// TO JOIN ROOM.
Db.getRows("SELECT * FROM `button-ic` WHERE lower(devicetype) = 'desktop' OR  lower(devicetype) = 'mobile'").then(rows=>
{
	if(rows.length>0)
	{
		buttonIC = rows;
		console.log("got button IC");
	}
},
err =>
{
	//res.send({success: false, message: "system failed to get button-ic information.", error_code: 124});
	console.error("error occured, error code 124",err);
});

Db.getRows("SELECT `sitevariable_id`, `value`, `valuetype`, `applicationarea` FROM sitevariable").then(rows=>
{
	if (rows.length > 0)
	{
		rows.forEach (row =>
		{
			siteVariables[row.sitevariable_id] =
			{
				value: row.value,
				valuetype: row.valuetype
			}
		});
	}
	console.log("got site variables");
});

// ONLY EXECUTE THIS CODE IF ITS ON PRODUCTION SERVER.
if(process.env.mode != 'norun')
{
	let snapshotInterval;
	let snapshot_query = "SELECT value FROM sitevariable WHERE sitevariable_id =" +
		" 'SV-GLOBAL-SERVER-CPUTRACKER-SNAPSHOT'";
	Db.getValue (snapshot_query).then (track_time =>
	{
		if (track_time)
		{
			setTimeout (() =>
			{
				// saveSnapShot ();
			}, track_time * 1000);
		}
	});
	
	function saveSnapShot ()
	{
		Db.getValue (snapshot_query).then (track_time =>
		{
			if (track_time)
			{
				Db.getValue ("SELECT count(room_id) FROM room where date(datetimestart) = CURDATE()").then (room_count =>
				{
					os.cpuUsage ((v) =>
					{
						let cpuload = (v * 100).toFixed (0);
						// let cpuloadavg = (os.loadavg (1) * 10).toFixed (0);
						let activerooms = 0;
						let totalparticipants = 0;
						let totalactiveparticipants = 0;
						let totalactivevideo = 0;
						let totalactiveaudio = 0;
						
						if (typeof roomMembers !== "undefined")
						{
							for (let roomname in roomMembers)
							{
								totalparticipants = roomMembers[roomname].length;
								if (totalparticipants > 0)
								{
									activerooms++;
								}
								for (let ir = 0; ir < roomMembers[roomname].length; ir++)
								{
									if (roomMembers[roomname][ir].userType != "listener")
									{
										totalactiveparticipants++;
										if (roomMembers[roomname][ir].cameraState == "live")
										{
											totalactivevideo++;
										}
										if (roomMembers[roomname][ir].micState == "live")
										{
											totalactiveaudio++;
										}
									}
								}
							}
							console.log ("==============", roomMembers);
						}
						let data =
							{
								activerooms: activerooms,
								totalparticipants: totalparticipants,
								totalactiveparticipants: totalactiveparticipants,
								totalactivevideo: totalactivevideo,
								totalactiveaudio: totalactiveaudio,
								cpuload: cpuload,
								totalrooms: room_count
							}
						console.log ("---------CPU STATS SAVED---------");
						Db.insert ("cputracker", data);
						
						setTimeout (() =>
						{
							saveSnapShot ();
						}, track_time * 1000);
					});
				})
			}
		});
	}
}

// HANDLING POST REQUEST TO UPLOAD FILE. WE ARE UPLOADING FILE IN A DIRECTORY TO MEASURE UPLOAD SPEED TEST.
// AFTER UPLOAD WE WILL EMPTY THE DIRECTORY.
app.post('/api/upload',multipartMiddleware, (req, res) => {
	console.log("api/upload");
	// GETTING ALL THE FILES IN DIRECTORY SO WE CAN DELETE THEM. WE DONT REQUIRE THEM ONCE THE SPEED TEST IS COMPLETE.
	fs.readdir(speedTestDir, (err, files) =>
	{
		console.log("api/upload red dir");
		if (err) throw err;
		if(files.length > 0)
		{
			for (const file of files)
			{
				fs.unlink (path.join (speedTestDir, file), err =>
				{
					if (err) throw err;
				});
			}
		}
	});
	res.send({
		'message': 'Process Complete.'
	});
});

// HANDLING GET REQUEST TO DOWNLOAD FILE. WE WILL GENERATE RANDOM DATA OF REQUIRED SIZE AND SEND IT TO CLIENT SIDE.
app.get('/api/download', (req, res) =>
{
	let randData = generate_random_data(10*1024*1024);
	res.send({
		'message': 'Process Complete.',
		'data': randData
	});
});

// HANDLING REQUEST TO SEND BUTTON-IC DATA TO CLIENT SIDE APP.
// app.get('/api/get-button-ic', (req, res) =>
// {
// 	Db.getRows("SELECT * FROM `button-ic` WHERE lower(devicetype) = 'desktop'").then(rows=>
// 	{
// 		res.send({success: true, rows: rows});
// 	},
// 	err =>
// 	{
// 		res.send({success: false, message: "system failed to get button-ic information.", error_code: 124});
// 		console.log("error occured, error code 124",err);
// 	});
// });

// HANDLING REQUEST TO GET DEVICE INFORMATION FROM FINGERPRINT, WE USE THIS FINGERPRING IN COOKIE.
app.post('/api/get-device', (req, res) =>
{
	Db.getRow("SELECT * FROM device WHERE fingerprintid = '"+req.body.fingerprint+"'").then(devicerow =>
	{
		if(devicerow)
		{
			res.send ({"success": true, "message": "Device fingerprint found.", "device": devicerow});
		}
		else
		{
			res.send ({"success": false, "message": "Device not found"});
		}
	},
	err =>
	{
		res.send({success: false, message: "system failed to get device information.", error_code: 126});
		console.log("error occured, error code 126",err);
	});
});


// HANDLING REQUEST TO SEND FIND ROOM JUMPCODES DATA TO CLIENT SIDE APP.
app.get('/api/find-room-jumpcode', (req, res) =>
{
	Db.getRows("SELECT jumpcode_id, jumpcode, description, accesslevel, takesParameter  FROM `jumpcode` WHERE area = 'FINDROOM' OR area = 'ALL'").then(rows=>
	{
		res.send({success: true, rows: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get jumpcode information.", error_code: 124});
		console.log("error occured, error code 124",err);
	});
});

// HANDLING REQUEST TO SEND FIND ROOM JUMPCODES DATA TO CLIENT SIDE APP.
app.get('/api/gettables', (req, res) =>
{
	Db.getRows("SELECT table_name as alltables from information_schema.tables where table_schema='"+process.env.mysqldb+"'").then(rows=>
	{
		res.send({success: true, rows: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get table names.", error_code: 124});
	});
});

// HANDLING REQUEST TO SEND FIND ROOM JUMPCODES DATA TO CLIENT SIDE APP.
app.get('/api/getroomformat', (req, res) =>
{
	Db.getRows("SELECT roomformat_id, roomformat from roomformat").then(rows=>
	{
		res.send({success: true, rows: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get room format.", error_code: 124});
	});
});

// HANDLING REQUEST TO SEND FIND ROOM JUMPCODES DATA TO CLIENT SIDE APP.
app.post('/api/gettabledata', (req, res) =>
{
	Db.getRows("SELECT * from "+req.body.tablename).then(rows=>
	{
		res.send({success: true, rows: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get table data "+req.body.tablename , error_code: 127});
		console.log("error occured, error code 127",err);

	});
});

// HANDLING REQUEST TO SEND FIND ROOM JUMPCODES DATA TO CLIENT SIDE APP.
app.post('/api/layout', (req, res) =>
{
	console.log("SELECT * FROM layout WHERE `devicetype_id` = '"+req.body.devicetype_id+"'");
	Db.getRows("SELECT * FROM layout WHERE `devicetype_id` = '"+req.body.devicetype_id+"'").then(rows=>
	{
		res.send({success: true, rows: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get table data layout" , error_code: 114});
		console.log("error occured, error code 114",err);
	});
});

app.get('/api/replace', (req, res) =>
{
	Db.getRows("SELECT * from `replace`").then(rows=>
	{
		res.send({success: true, rows: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get table data replace" , error_code: 124});
		console.log("error occured, error code 114",err);

	});
});

app.get('/api/forbiddenwords', (req, res) =>
{
	Db.getRows("SELECT * from `forbiddenword`").then(rows=>
	{
		res.send({success: true, rows: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get table data forbiddenword" , error_code: 124});
		console.log("error occured, error code 114",err);

	});
});

app.get('/api/words', (req, res) =>
{
	let words = [];

	// GET NAMES FROM WORD TABLE
	Db.getRows("SELECT * from `word`").then(rows=>
	{
		rows.forEach(word => {
			words.push(word.word_id)
		});
		
		// GET NAMES FROM NAME TABLE
		Db.getRows("SELECT * from `name` where isActive=1").then(rows=>
		{
			rows.forEach(name => {
				words.push(name.name_id)
			});
			
			// SEND THE RESPONSE TO CLIENT
			res.send({success: true, rows: words});
		},
		err =>
		{
			res.send({success: false, message: "system failed to get table data name" , error_code: 124});
			console.log("error occured, error code 114",err);
	
		});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get table data word" , error_code: 124});
		console.log("error occured, error code 114",err);

	});
});


// HANDING REQUEST TO GET SITEVARIABLES FROM DATABASE.
app.get('/api/getsitevariables', (req, res) =>
{
	Db.getRows("SELECT `sitevariable_id`, `value`, `valuetype`, `applicationarea` FROM sitevariable").then(rows=>
	{
		if (rows.length > 0)
		{
			rows.forEach (row =>
			{
				siteVariables[row.sitevariable_id] =
				{
					value: row.value,
					valuetype: row.valuetype
				}
			});
		}
		res.send({success: true, data: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get site variables.", error_code: 128});
		console.log("error occured, error code 128",err);
	});
});

// HANDING REQUEST TO GET SITEMESSAGES FROM MESSAGE TABLE.
app.get('/api/getsitemessages', (req, res) =>
{
	Db.getRows("SELECT * FROM message").then(rows=>
	{
		res.send({success: true, data: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get message table.", error_code: 129});
		console.log("error occured, error code 129",err);
	});
});

// HANDING REQUEST TO GET ALL JUMPCODES FROM DATABASE.
app.get('/api/getjumpcodes', (req, res) =>
{
	Db.getRows("SELECT * FROM jumpcode").then(rows=>
	{
		res.send({success: true, data: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get site variables.", error_code: 130});
		console.log("error occured, error code 130",err);
	});
});

// HANDLING REQUEST TO GET AVAILABLE ROOM NAMES FROM DATABASE.
app.post('/api/getavailablerooms', (req, res) =>
{
	let fromQuery = "FROM room where DATE(datetimestart) = DATE(CURRENT_TIMESTAMP) AND HOUR(datetimestart) >= HOUR(CURRENT_TIMESTAMP) AND state != 'E' ";
	
	// IF PARAMETER TO MATCH ROOM NAME IN DATABASE IS SENT, THEN LOOK FOR IT.
	if(req.body.match)
	{
		fromQuery += " AND (roomname like '%"+req.body.match+"%' OR roomname like '%"+req.body.match+"%' OR" +
			" roomname like '%"+req.body.match+"%' )";
	}
	
	let limitQuery = "LIMIT "+req.body.limitFrom+", "+req.body.roomRows;
	Db.getRows ("SELECT room_id,roomformat_id, shortdescription, roomname,concat(datetimestart, ' GMT-0500') as datetimestart,state "+ fromQuery).then(rows=>
	{
		// Db.getValue("SELECT count(room_id) " + fromQuery).then(countRows =>
		// {
		// 	res.send({success: true, rooms: rows, rows_count: countRows});
		// })
		rows.forEach(row=>
		{
			let startDate = new Date(row.datetimestart);
			var hours = startDate.getHours();
			var ampm = (hours >= 12) ? "PM" : "AM";
			var hoursToDisplay = (hours >= 12) ? hours-12 : hours;
				row['startTime'] = hoursToDisplay+ampm;
		});
		res.send({success: true, rooms: rows});

	},
	err =>
	{
		res.send({success: false, message: "system failed to get available rooms.", error_code: 116});
		console.log("error occured, error code 116",err);
	});
});

// HANDLING REQUEST TO GET FEEDBACK BUTTONS FROM DATABASE.
app.get('/api/get-feedback-buttons', (req, res) =>
{
	Db.getRows("SELECT * FROM `button-fb`").then(rows=>
	{
		res.send({success: true, rows: rows});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get feedback buttons.", error_code: 125});
		console.log("error occured, error code 125",err);
	});
});

// HANDLING REQUEST TO GET ROOM INFO
app.post('/api/get-room', (req, res) =>
{
	Db.getRow("SELECT * FROM room where room_id = '"+req.body.room_id+"'").then(row=>
	{
		// GET MEMBERS OF ROOM.
		let roomUsers = [];
		console.log("============roomMembers==============",roomMembers);
		if(typeof roomMembers['room_'+req.body.room_id] !== "undefined")
		{
			roomUsers = roomMembers['room_' + req.body.room_id];
		}
		console.log("-------roomUsers---------", roomUsers);
		
		// LETS SEND ROOM INFORMATION, ROOM USERS INFORMATION FROM roomMembers ARRAY.
		
		let room = "room_"+req.body.room_id;
		let room_chats = [];
		let private_room_chats = [];
		if(typeof roomChats[room] !== "undefined")
		{
			room_chats = roomChats[room];
		}
		
		// IF THERE IS PRIVATE CHAT IN THE ROOM, THEN WE WILL SAVE IT IN A VARIABLE AND SEND IT TO ROOM.
		if(typeof privateRoomChats[room] !== "undefined")
		{
			private_room_chats = privateRoomChats[room];
		}
		
		// IF THERE IS ANY ROOMSETTINGS AVAIALBLE, THEN SEND IT TO CONNECTING USER.
		let room_settings = [];
		if(typeof roomSettings[room] !== "undefined")
		{
			room_settings = roomSettings[room];
		}
		res.send(
		{
			success: true,
			room: row,
			users: roomUsers,
			privateRoomChats:private_room_chats,
			roomChats: room_chats,
			roomSettings: room_settings,
			buttonIC: buttonIC
		});
	},
	err =>
	{
		res.send({success: false, message: "System failed to get room information", error_code: 119});
		console.log("error occured, error code 119",err);
	});
});

// HANDLING REQUEST TO UPDATE ROOM STATE. LIKE CHANGING THE STATE FROM NEVER ACTIVATED TO ACTIVATED, WHEN USER
// ACTIVATES THE ROOM FOR TH FIRST TIME.
app.post('/api/update-room-state', (req, res) =>
{
	Db.update("room", {state: req.body.state}, "WHERE room_id = '"+req.body.room_id+"'").then(result=>
	{
		res.send({success: true});
	},
	err =>
	{
		res.send({success: false, message: "System failed to update room state", error_code: 120});
		console.log("error occured, error code 120",err);
	});
});

// HANDLING REQUEST TO CLEAR ALL ROOMS THROUGH CLEAR JUMP CODE
app.post('/api/clear-rooms', (req, res) =>
{
	Db.update("room", {state: "E"}, "WHERE state = 'A'").then(result=>
	{
		res.send({success: true});
	},
	err =>
	{
		res.send({success: false, message: "System failed to clear room state", error_code: 120});
		console.log("error occured, error code 120",err);
	});
});

// HANDLING REQUEST TO GET ROOM NAMES FROM DATABASE
app.post('/api/getroomnames', (req, res) =>
{
	let data = [];

	// SEARCH WORD TABLE
	Db.getRows("SELECT word_id FROM word where LOWER(word_id) like LOWER('"+req.body.value+"%')").then(rows=>
	{
		rows.forEach(row=>
		{
			data.push(row.word_id);
		});
		
		// SEARCH NAME TABLE ALSO
		Db.getRows("SELECT name_id FROM name where LOWER(name_id) like LOWER('"+req.body.value+"%')").then(rows=>
		{
			rows.forEach(row=>
			{
				data.push(row.name_id);
			});
			
			// SORT ALPHABETICALLY BEFORE SENDING THE DATA.
			data.sort();
			res.send({success: true, names: data});
		},
		err =>
		{
			res.send({success: false, message: "system failed to get room names.", error_code: 115});
			console.log("error occured, error code 115",err);
		});		
	},
	err =>
	{
		res.send({success: false, message: "system failed to get room names.", error_code: 115});
		console.log("error occured, error code 115",err);
	});
});

// HANDLING REQUEST TO FIND IF THE VALUE SENT IS A ROOM NAME FROM DATABASE
app.post('/api/findroomname', (req, res) => 
{
	let names = [];

	// CHECK WORD TABLE FIRST
	Db.getRows("SELECT word_id FROM word where LOWER(word_id) like LOWER('"+req.body.value+"')").then(rows=>
	{
		if(rows.length > 0)
		{
			names.push(rows.word_id);
		}

		// NOW CHECK NAME TABLE
		Db.getRows("SELECT name_id FROM name where name_id like LOWER('"+req.body.value+"')").then(rows=>
		{
			if(rows.length > 0)
			{
				names.push(rows.name_id);
			}
			if(names.length == 0)
			{
				res.send({success: false, message: "not found"});
			}
			else 
			{
				res.send({success: true, message: "found"});
			}
		},
		err =>
		{
			res.send({success: false, message: "system failed to find room names.", error_code: 123});
			console.log("error occured, error code 123",err);
		});
	},
	err =>
	{
		res.send({success: false, message: "system failed to find room names.", error_code: 123});
		console.log("error occured, error code 123",err);
	});
});

// HANDLING REQUEST TO FIND IF THE VALUE SENT IS A ROOM NAME FROM DATABASE
app.post('/api/findscreenname', (req, res) => 
{
	Db.getRows("SELECT name_id FROM name where name_id like '"+req.body.value+"'").then(rows=>
		{
			console.log("inside findScreenname");
			if(rows.length == 0)
			{
				res.send({success: false, message: "not found"});
			}
			else 
			{
				res.send({success: true, message: "found"});
			}
		},
		err =>
		{
			res.send({success: false, message: "system failed to find room names.", error_code: 123});
			console.log("error occured, error code 123",err);
		});
});

// HANDLING REQUEST TO GET SCREEN NAMES FROM DATABASE
app.post('/api/getscreennames', (req, res) =>
{
	Db.getRows("SELECT name_id FROM name where name_id like '"+req.body.value+"%'").then(rows=>
	{
		let data = [];
		rows.forEach(row=>
		{
			data.push(row.name_id);
		});
		res.send({success: true, names: data});
	},
	err =>
	{
		res.send({success: false, message: "system failed to get room names.", error_code: 117});
		console.log("error occured, error code 117",err);
	});
});

// UPDATE DEVICE TABLE WHEN THE SCREENNAME IS CHANGED FOR A DEVICE
app.post('/api/updateName', (req, res) =>
{
	// UPDATE THE DEVICE TABLE WITH THE EDITED SCREEN NAME
	let lastscreenname = {lastname: req.body.username};
	Db.update ("device", lastscreenname, "WHERE device_id = '"+req.body.device_id+"'").then (result =>
	{
		res.send ({"success": true, "message": "screen name saved successfully", screenname: lastscreenname});
	}, err =>
	{
		res.send ({"success": false, "message": "screen name not saved", screenname: lastscreenname});
	});
});

app.post('/api/validateUserName', (req, res) =>
{
	// UPDATE THE DEVICE TABLE WITH THE EDITED SCREEN NAME
	Db.getValue("SELECT name_id FROM name WHERE name_id = '"+req.body.username+"'").then (result =>
	{
		if(result)
		{
			res.send ({"success": true, "message": "screen name exist"});
		}
		else
		{
			res.send ({"success": false, "message": "screen name does not exist", "error_code": 131});
		}
	}, err =>
	{
		res.send ({"success": false, "message": "screen name not saved", "error_code": 132});
	});
});


// STORING ROOM INFORMATION IN DATABASE
app.post('/api/store/room', (req, res) =>
{
	try
	{
		let ip_address = req.socket.address().address;
		let ipversion = req.socket.address().family;
		let ipaddress = req.clientIp;
		
		// REMOVE THE LEADING CHARACTERS FROM THE IP ADDRESS IF PRESENT.
		if (ipaddress.substr(0, 7) == "::ffff:") 
		{
			ipaddress = ipaddress.replace('::ffff:', '');
		}
		if (ip_address.substr(0, 7) == "::ffff:") 
		{
			ip_address = ip_address.replace('::ffff:', '');
		}
		console.log("ipaddress", ipaddress);

		Db.getValue("SELECT room_id FROM room WHERE roomname = '"+req.body.roomname1+" " +
			+req.body.roomname2+" " + req.body.roomname3+"'" +
			" AND date(datetimestart) = '"+req.body.date+"'").then(value =>
		{
			if (!value)
			{
				req.body.hostipv6 = ip_address;
				req.body.hostipv4 = ipaddress;
				console.log(req.body);
				
				// INSERTING DATA INTO DATABASE
				Db.insert ("room",req.body).then (result =>
				{
					let room_id = result.insertId;

					// UPDATE THE DEVICE TABLE WITH THE LAST USED SCREENNAME FOR THIS NEWLY CREATED ROOM 
					let lastscreenname = {lastname: req.body.hostname};

					Db.update ("device", lastscreenname, "WHERE device_id = '"+req.body.device_id+"'").then (result =>
					{
						console.log("screen name saved successfully");
					}, err =>
					{
						res.send ({"success": false, "message": "screen name not saved", screenname: lastscreenname});
					});
					res.send ({"success": true, "message": "room data saved", room_id: room_id});
				}, err =>
				{
					console.log ("error occurred 105", err);
					res.send ({"success": false, "message": "error occurred 105"});
				});
			}
			else
			{
				console.log("room is already there. ", value);
				res.send ({"success": true, "message": "room is already available", room_id: value});
			}
		}, err =>
		{
			console.log ("error occurred 106", err);
			res.send ({"success": false, "message": "error occurred 106"});
		});
	}
	catch(e){
		console.log("api/store/room ", e);
	}
});

app.post('/api/store/roomdetail', (req, res) =>
{
	room_id = req.body.room_id;
	// MAKE SURE THIS ROOM EXIST IN SYSTEM, IF IT DOES THEN SAVE THE DATA, OTHERWISE DISPLAY ERROR TO USER.
	if(room_id)
	{
		// CHECK IF WE HAVE NOT ALREADY STORED THE CURRENT USER INFORMATION. IF NOT THEN SAVE IT OTHERWISE JUST
		// SKIP IT AND SEND ROOMDETAIL_ID TO CLIENT SIDE.
		Db.getRow("SELECT * FROM roomdetail WHERE LOWER(name) = '" + req.body.username.toLowerCase() + "' " +
			" AND device_id = '" + req.body.device_id + "'" +
			"AND room_id = '"+room_id+"' ").then(row =>
		{
			if(row)
			{
				// SO USER INFO IS ALREADY STORED, WE WILL JUST SEND ID TO CLIENT.
				res.send (
				{
					"success": true,
					"message": "user info already saved.",
					room_id: room_id,
					roomdetail_id: row['roomdetail_id'],
					row: row
				});
			}
			else
			{
				// USER INFO DOES NOT EXIST IN DB, LETS SAVE IT NOW.
				Db.insert ("roomdetail",
				{
					room_id: room_id,
					name: req.body.username,
					device_id: req.body.device_id,
					isHost: req.body.isHost,
					usertype: req.body.userType.charAt(0),
				}).then (result =>
				{
					res.send (
					{
						"success": true,
						"message": "user info saved successfully",
						room_id: room_id,
						roomdetail_id: result.insertId,
					});
				}, err =>
				{
					console.log ("error occurred 104", err);
					res.send ({"success": false, "message": "error occurred 104"});
				});
			}
		}, err =>
		{
			console.log ("error occurred 109", err);
			res.send ({"success": false, "message": "error occurred 109"});
		});
	}
	else
	{
		res.send ({"success": false, "message": "Room does not exist", "show_to_client": true});
	}
	
});

app.post('/api/store/device', (req, res) =>
{
	try
	{
		let components = req.body.components;
		let fphash = req.body.fphash;
		let deviceInfo = req.body.deviceInfo;
		
		// EXTRACTING REQUIRED INFORMATION FROM COMPONENTS ARRAY PROVIDED BY FINGERPRINTJS LIBRARY.
		let colorDepth = components.find (element => element.key == "colorDepth").value;
		let screenSize = components.find (element => element.key == "screenResolution").value;
		let system_fonts = components.find (element => element.key == "fonts").value;
		let userAgent = components.find (element => element.key == "userAgent").value;
		let videoCard = components.find (element => element.key == "webglVendorAndRenderer").value;
		
		// CANVAS AND WEBGL VALUES ARE TOO BIG, BETTER TO SAVE THEM IN HASH FORMAT.
		let canvas = crypto.createHash("md5").update(components.find(element => element.key == "canvas").value[1]).digest('hex');
		let webgl = crypto.createHash("md5").update(components.find(element => element.key == "webgl").value[0]).digest('hex');
		if(system_fonts)
		{
			// JOINING THE SYSTEM FONTS ARRAY AND CONVERTING THEM INTO STRING, THEN WE WILL CONVERT IT INTO HASH TO
			// EASILY STORE INTO DATABASE.
			system_fonts = system_fonts.join().toString();
			system_fonts = crypto.createHash("md5").update(system_fonts).digest('hex');
		}
		console.log("-------- screen size "+ screenSize[0], screenSize[1]);
		
		// CHECK IF WE HAVE NOT ALREADY STORED THIS FINGERPRINT. IF NOT THEN WE WILL SAVE IT IN DATABASE, OTHERWISE
		// WE WILL SKIP IT.
		// REFER TO DB.JS FOR MORE INFO ABOUT DB FUNCTIONS.
		Db.getRow("SELECT * FROM device WHERE fingerprintid = '"+fphash+"'").then(devicerow =>
		{
			let ipaddress = req.clientIp;

			// REMOVE THE LEADING CHARACTERS FROM THE IP ADDRESS IF PRESENT.
			if (ipaddress.substr(0, 7) == "::ffff:") 
			{
				ipaddress = ipaddress.replace('::ffff:', '');
			}

			// IF THE DEVICE INFORMATION IS NOT FOUND IN THE TABLE, MAKE A NEW ENTRY.
			if(!devicerow)
			{
				Db.insert ("device",
				{
					devicetype_id: "WINDOWS",
					fingerprintid: fphash,
					ip: ipaddress,
					useragent: userAgent,
					screensizeheight: screenSize[0],
					screensizewidth: screenSize[1],
					systemfonts: system_fonts,
					os: deviceInfo.os.name + " | " + deviceInfo.os.version,
					browser: deviceInfo.browser.name + " | " + deviceInfo.browser.version,
					hashcanvas: canvas,
					hashwebgl: webgl,
					colordepth: colorDepth,
					videocard: videoCard,
					// hasVideoCard: (videoCard ? 1:0),
					hasWebcam: (req.body.hasWebcam === false ? 0 : 1),
					hasMicrophone: (req.body.hasMicrophone === false ? 0 : 1),
				}).then (result =>
				{
					let device_id = result.insertId;
					Db.getRow("SELECT * FROM device WHERE device_id = '"+device_id+"'").then(devicerow =>
					{
						res.send ({"success": true, "message": "data saved", device: devicerow});

					}, err =>
					{
						res.send ({"success": false, "message": "Error code 102. "});
						console.error("error 102 ", err);
					});
				}, err =>
				{
					console.log ("error occurred", err);
				});
			}
			else
			{
				// DEVICE ALREADY REGISTERED. RETURN DEVICE INFO BACK TO THE APPLICATION.
				res.send ({"success": true, "message": "Device info already saved", "device": devicerow});
			}
		},
		err =>
		{
			res.send ({"success": false, "message": "Error code 102. "});
			console.error("error 102 ", err);
		});
	}
	catch (e)
	{
		res.send ({"success": false, "message": "Error code 101. "});
		console.error("error code: 101", e);
	}
});

// UPDATING VALUES IN ROOM DETAIL TABLE. VALUES WILL BE SENT FROM CLIENT, VALUES CAN BE DIFFERENT NUMBER OF FIELDS
// WE WANT TO UPDATE IN ROOMDETAIL TABLE.
app.post('/api/store/update_room_detail', (req, res) =>
{
	Db.update ("roomdetail",req.body.data, "WHERE roomdetail_id = '"+req.body.roomdetail_id+"'").then (result =>
	{
		res.send ({success: true, message: "Update successful"});
	}, err =>
	{
		console.error ("error occurred 111", err);
		res.send ({success: false, message: "error occurred", error_code:111});
	});
});

// UPDATING VALUES IN ROOM TABLE. VALUES WILL BE SENT FROM CLIENT, VALUES CAN BE DIFFERENT NUMBER OF FIELDS
// WE WANT TO UPDATE IN ROOM TABLE.
app.post('/api/update_room', (req, res) =>
{
	Db.update ("room",req.body.data, "WHERE room_id = '"+req.body.room_id+"'").then (result =>
	{
		res.send ({success: true, message: "Update successful"});
	}, err =>
	{
		console.error ("error occurred 121", err);
		res.send ({success: false, message: "error occurred", error_code:121});
	});
});

// RETURN ALL SCROLL ITEMS FROM THE GIVEN URL.
app.post('/api/getscrollitems', (req, res) =>
{
	let path = require('path');
	var dirPath = path.join(__dirname, '..', 'client', 'src', 'assets');
	let url = req.body.url;
	let urlParts = [];

	if(url.indexOf("/"))
	{	
		urlParts = url.split("/");
	}
	else if(url.indexOf("\\"))
	{
		urlParts = url.split("\\");
	}

	urlParts.forEach(urlpart=>
	{
		dirPath = path.join(dirPath, urlpart);
	});
	
	console.log(dirPath);

	let items = getFiles(dirPath);
	res.send ({success: true, files: items});
	console.log(items);
});

// UPDATING DEVICE TABLE.
app.post('/api/update_device', (req, res) =>
{
	Db.update ("device",req.body.data, "WHERE device_id = '"+req.body.device_id+"'").then (result =>
	{
		res.send ({success: true, message: "Update successful"});
	}, err =>
	{
		console.error ("error occurred 122", err);
		res.send ({success: false, message: "error occurred", error_code:122});
	});
});

// STORING MIN/MAX BANDWIDTH OF USRE TO DATABASE, WE WILL SEE IF THE CURRENT VALUE IS LESS THAN THE SAVED VALUE, IF
// YEST THEN WE WILL SAVE THE NEW MIN_BANDWIDTH, SAME GOES FOR MAX_BANDWIDTH
app.post('/api/store/bandwidth_info', (req, res) =>
{
	let update = {bandwidthmin:0, bandwidthmax:0};
	Db.getRow("SELECT bandwidthmin,bandwidthmax FROM roomdetail WHERE roomdetail_id = '"+ req.body.roomdetail_id +"'").then(row=>
	{
		// IF CURRENT MIN BANDWIDTH IS LESS THAN LAST SAVED MIN BANDWIDTH THEN UPDATE DATABASE AND PUT LATEST VALUE
		// OF MIN BANDWIDTH. MAKE SURE THAT ITS NOT 0 THAT IS STORED IN DATABASE, BECAUSE IN THIS CASE WE WONT HAVE
		// CORRECT VALUE OF MIN BANDWIDTH.
		if(row.bandwidthmin == 0 || ( req.body.bandwidthmin > 0 && req.body.bandwidthmin < row.bandwidthmin))
		{
			// PUT IT IN VARIABLE, SO WE WILL HAVE TO RUN MYSQL QUERY FOR ONE TIME ONLY.
			update.bandwidthmin = req.body.bandwidthmin;
		}
		else
		{
			// OTHERWISE PUT THE OLD VALUE IN VARIABLE, SO WE CAN SAVE IT IN DATABASE.
			update.bandwidthmin = row.bandwidthmin;
		}
		// IF NEW BANDWIDTH IS GREATER THAN THAT WAS SAVED IN DB, THEN UPDATE IT AND PUT NEW ONE.
		if(req.body.bandwidthmax > row.bandwidthmax)
		{
			update.bandwidthmax = req.body.bandwidthmax;
		}
		else
		{
			update.bandwidthmax = row.bandwidthmax;
		}
		// NOW WE WILL RUN THE DATABASE UPDATE QUERY TO UPDATE NEW VALUES IN ROOMDETAIL TABLE.
		Db.update ("roomdetail",update, "WHERE roomdetail_id = '"+req.body.roomdetail_id+"'").then (result =>
		{
			res.send ({success: true, message: "Update successful"});
		}, err =>
		{
			console.error ("error occurred 112", err);
			res.send ({success: false, message: "error occurred", error_code:112});
		});
	},err=>
	{
		console.error ("error occurred 113", err);
	})
});

// SAVING USER ERRORS INTO DATABASE.
app.post('/api/store/roomerror', (req, res) =>
{
	Db.insert ("log-error",
	{
			roomdetail_id: req.body.roomdetail_id,
			message: req.body.message,
	}).then (result =>
	{
		res.send ({success: true, message: "Error report sent"});
	}, err =>
	{
		console.error ("error occurred 110", err);
		res.send ({success: false, message: "error occurred", error_code:110});
	});
});

// API ROUTE TO DOWNLOAD YOUTUBE VIDEOS AGAINST THE URL
app.post ("/api/youtube/download", (req, res, next) =>
{
	const video_url = req.body.url;
	
	// HANDLER FUNCTION TO DOWNLOAD THE VIDEO AND STORE IT IN OUR SERVER
	return download (video_url).then ((result) =>
	{
		res.json (JSON.stringify ({result}));
	})
});

// API TO STREAM YOUTUBE VIDEOS
app.get('/api/youtube/getvideo/:url', function (req, res)
{
	console.log("inside youtube");
	const id = req.params.url;
	console.log ('PRAMS==>', req.params);
	
	const VIDEO_DIR = `${__dirname}/youtube_videos/${id}`;
	const path = VIDEO_DIR;
	const stat = fs.statSync (path)
	const fileSize = stat.size
	const range = req.headers.range
	
	// IF THE VIDEO HAS SOME BYTES OF RANGE
	if (range)
	{
		const parts = range.replace (/bytes=/, "").split ("-")
		const start = parseInt (parts[0], 10)
		const end = parts[1]
			? parseInt (parts[1], 10)
			: fileSize - 1
		const chunksize = (end - start) + 1
		const file = fs.createReadStream (path, {start, end})
		const head = {
			'Content-Range': `bytes ${start}-${end}/${fileSize}`,
			'Accept-Ranges': 'bytes',
			'Content-Length': chunksize,
			'Content-Type': 'video/mp4',
		}
		res.writeHead (206, head);
		file.pipe (res);
	} else
	{
		const head = {
			'Content-Length': fileSize,
			'Content-Type': 'video/mp4',
		}
		res.writeHead (200, head)
		fs.createReadStream (path).pipe (res)
	}
});

// API TO DOWNLOAD MP4 TO STREAM IT
app.get ('/api/mp4/download/:name', function (req, res)
{
	const name = req.params.name;
	console.log ('PRAMS==>', req.params);
	const VIDEO_DIR = `${__dirname}/mp4/${name}`;
	const path = VIDEO_DIR;
	const stat = fs.statSync (path);
	const fileSize = stat.size;
	const range = req.headers.range;
	
	// HEADER HAS RANGE INFORMATION THEN SPLIT THEM
	if (range)
	{
		const parts = range.replace (/bytes=/, "").split ("-")
		const start = parseInt (parts[0], 10)
		const end = parts[1]
			? parseInt (parts[1], 10)
			: fileSize - 1
		const chunksize = (end - start) + 1
		const file = fs.createReadStream (path, {start, end})
		const head = {
			'Content-Range': `bytes ${start}-${end}/${fileSize}`,
			'Accept-Ranges': 'bytes',
			'Content-Length': chunksize,
			'Content-Type': 'video/mp4',
		}
		res.writeHead (206, head);
		file.pipe (res);
	} else
	{
		const head = {
			'Content-Length': fileSize,
			'Content-Type': 'video/mp4',
		}
		res.writeHead (200, head)
		fs.createReadStream (path).pipe (res)
	}
});

let uploads = {};

app.post ('/api/images/upload', (req, res, next) =>
{
	let fileId = req.headers['x-file-id'];
	let startByte = parseInt (req.headers['x-start-byte'], 10);
	let name = req.headers['name'];
	let fileSize = parseInt (req.headers['size'], 10);
	console.log ('file Size', fileSize, fileId, startByte);
	
	// FILE ALREADY PRESENT ON THE SERVER
	if (uploads[fileId] && fileSize == uploads[fileId].bytesReceived)
	{
		console.log("already present");
		res.end ();
		return;
	}
	
	console.log (fileSize);
	
	// IF NO FILE ID IS PASSED, IT WON'T ABLE TO FIND IT. RETURN WITH ERROR
	if (!fileId)
	{
		res.writeHead (400, "No file id");
		res.end (400);
	}
	console.log (uploads[fileId]);
	
	// NO FILE ID IS STORE IN THE UPLOADS ARRAY
	if (!uploads[fileId])
		uploads[fileId] = {};
	
	let upload = uploads[fileId];
	
	let fileStream;
	
	// START BYTE IS PRESENT
	if (!startByte)
	{
		upload.bytesReceived = 0;
		let name = req.headers['name'];
		fileStream = fs.createWriteStream (`${__dirname}/images/${name}`);
	} else
	{
		
		// START BYTE IS INCORRECT THE RETURN ERROR
		if (upload.bytesReceived != startByte)
		{
			res.writeHead (400, "Wrong start byte");
			res.end (upload.bytesReceived);
			return;
		}
		// APPEND EXISTING FILE
		fileStream = fs.createWriteStream (`${__dirname}/images/${name}`, {
			flags: 'a'
		});
	}
	
	req.on ('data', function (data)
	{
		upload.bytesReceived += data.length;
	});
	
	req.pipe (fileStream);
	
	// HOOK TO TELL WHEN FILE STREAM IS FINISHED
	fileStream.on ('close', function ()
	{
		console.log (upload.bytesReceived, fileSize);
		
		// CHECK TO SEE IF UPLOADING IS SUCCESSFUL AND COMPLETED
		if (upload.bytesReceived == fileSize)
		{
			console.log ("Upload finished");
			delete uploads[fileId];
			
			// RETURN SUCCESS MESSAGE
			res.send ({'status': 'uploaded'});
			res.end ();
		} else
		{
			// FOR SOME REASON THE UPLOAD IS NOT SUCCESSFUL, RETURN WITH ERROR
			console.log ("File unfinished, stopped at " + upload.bytesReceived);
			res.writeHead (500, "Server Error");
			res.end ();
		}
	});
	
	// HOOK IN CASE OF ERROR, RETURN MESSAGE
	fileStream.on ('error', function (err)
	{
		console.log ("fileStream error", err);
		res.writeHead (500, "File error");
		res.end ();
	});
	
});

// API TO SEND BACK the SVG TO THE MEDIA SCROLL VIEW
app.get ('/api/images/download/:name', function (req, res)
{
	const name = req.params.name;
	console.log ('PRAMS==>', req.params);
	const IMAGES_DIR = `${__dirname}/images/${name}`;
	res.sendFile(IMAGES_DIR);
});


app.post ('/api/fileUpload', (req, res, next) =>
{
	let fileId = req.headers['x-file-id'];
	let startByte = parseInt (req.headers['x-start-byte'], 10);
	let name = req.headers['name'];
	let fileSize = parseInt (req.headers['size'], 10);
	console.log ('file Size', fileSize, fileId, startByte);
	
	// FILE ALREADY PRESENT ON THE SERVER
	if (uploads[fileId] && fileSize == uploads[fileId].bytesReceived)
	{
		res.end ();
		return;
	}
	
	console.log (fileSize);
	
	// IF NO FILE ID IS PASSED, IT WON'T ABLE TO FIND IT. RETURN WITH ERROR
	if (!fileId)
	{
		res.writeHead (400, "No file id");
		res.end (400);
	}
	console.log (uploads[fileId]);
	
	// NO FILE ID IS STORE IN THE UPLOADS ARRAY
	if (!uploads[fileId])
		uploads[fileId] = {};
	
	let upload = uploads[fileId];
	
	let fileStream;
	
	// START BYTE IS PRESENT
	if (!startByte)
	{
		upload.bytesReceived = 0;
		let name = req.headers['name'];
		fileStream = fs.createWriteStream (`${__dirname}/mp4/${name}`);
	} else
	{
		
		// START BYTE IS INCORRECT THE RETURN ERROR
		if (upload.bytesReceived != startByte)
		{
			res.writeHead (400, "Wrong start byte");
			res.end (upload.bytesReceived);
			return;
		}
		// APPEND EXISTING FILE
		fileStream = fs.createWriteStream (`${__dirname}/mp4/${name}`, {
			flags: 'a'
		});
	}
	
	req.on ('data', function (data)
	{
		upload.bytesReceived += data.length;
	});
	
	req.pipe (fileStream);
	
	// HOOK TO TELL WHEN FILE STREAM IS FINISHED
	fileStream.on ('close', function ()
	{
		console.log (upload.bytesReceived, fileSize);
		
		// CHECK TO SEE IF UPLOADING IS SUCCESSFUL AND COMPLETED
		if (upload.bytesReceived == fileSize)
		{
			console.log ("Upload finished");
			delete uploads[fileId];
			
			// RETURN SUCCESS MESSAGE
			res.send ({'status': 'uploaded'});
			res.end ();
		} else
		{
			// FOR SOME REASON THE UPLOAD IS NOT SUCCESSFUL, RETURN WITH ERROR
			console.log ("File unfinished, stopped at " + upload.bytesReceived);
			res.writeHead (500, "Server Error");
			res.end ();
		}
	});
	
	// HOOK IN CASE OF ERROR, RETURN MESSAGE
	fileStream.on ('error', function (err)
	{
		console.log ("fileStream error", err);
		res.writeHead (500, "File error");
		res.end ();
	});
	
});

// API TO GET THE STATUS OF THE UPLOAD
app.get ('/api/status', (req, res) =>
{
	let fileId = req.headers['x-file-id'];
	let name = req.headers['name'];
	let fileSize = parseInt (req.headers['size'], 10);
	console.log (name);
	if (name)
	{
		try
		{
			let stats = fs.statSync ('name/' + name);
			if (stats.isFile ())
			{
				console.log (`fileSize is ${fileSize} and already uploaded file size ${stats.size}`);
				if (fileSize == stats.size)
				{
					res.send ({'status': 'file is present'})
					return;
				}
				if (!uploads[fileId])
					uploads[fileId] = {}
				console.log (uploads[fileId]);
				uploads[fileId]['bytesReceived'] = stats.size;
				console.log (uploads[fileId], stats.size);
			}
		} catch (er)
		{
			console.log ('ERR', er);
		}
		
	}
	let upload = uploads[fileId];
	if (upload)
		res.send ({"uploaded": upload.bytesReceived});
	else
		res.send ({"uploaded": 0});
	
});

server.listen (process.env.port || 3000);
console.log ('Server started.');
var userTypes = dataType = new Array ();
var roomStreams = [];
var interval_registered = [];

// FUNCTION TO GENERATE RANDOM DATA OF ANY GIVEN SIZE, SIZE MUST IN BYTES. WE WILL USE THIS FUNCTION TO GENERATE
// DATA FOR UPLOAD SPEED TEST.
function generate_random_data(size)
{
	var chars = 'abcdefghijklmnopqrstuvwxyz'.split('');
	var len = chars.length;
	var random_data = [];
	
	while (size--) {
		random_data.push(chars[Math.random()*len | 0]);
	}
	
	return random_data.join('');
}

// READ ALL FILE NAMES FROM A DIRECTORY GIVEN THE PATH.
function getFiles (dir, files_){
    files_ = files_ || [];
    var files = fs.readdirSync(dir);
	for (var i in files)
	{
        var name = dir + '/' + files[i];
		if (fs.statSync(name).isDirectory())
		{
            getFiles(name, files_);
		} 
		else 
		{
            files_.push(files[i]);
        }
    }
    return files_;
}


// WHENEVER SOCKET IS CONNECTED, CALL THE FUNCTION clientConnected
io.sockets.on ('connection', clientConnected);

// FUNCTION TO DEAL WITH ACTIVITIES WE NEED TO DO AFTER SOCKET CONNECTION.
function clientConnected (socket)
{
	// THIS MESSAGE WILL BE TRIGGERED WHEN USER IS OUTSIDE THE ROOM
	socket.on('send_message_to_room_host', function(data)
	{
		let send_to_room = "room_"+data.room_id;
		
		// LETS SEE IF THE HOST EXIST FOR THIS ROOM, IF THEY DO THEN WE WILL SEND THEM MESSAGE.
		if(typeof roomHostsSockets[send_to_room] !== "undefined")
		{
			io.sockets.to (roomHostsSockets[send_to_room]).emit ("message_for_host", data);
		}
	});
	
	// SENDING MESSAGE TO USER WHOSE STREAM ID WE NEED TO CHANGE.
	socket.on ('changeStreamId', function (data)
	{
		console.log ("----------------------------emited changeStreamId -------------------------", socket.room, data.old);
		socket.streamId = data.streamId;
		socket.join (data.streamId);
		socket.join (socket.room);
		
		// CHANGE THE STREAM ID OF THAT USER IN roomMembers ARRAY.
		for (var i = 0; i < roomMembers[socket.room].length; i++)
		{
			console.log (roomMembers[socket.room][i].streamId + " ============== " + data.old + " | " + data.streamId);
			if (roomMembers[socket.room][i].streamId == data.old)
			{
				roomMembers[socket.room][i].streamId = data.streamId;
				roomMembers[socket.room][i].streamId = data.streamId;
				console.log ("-------------stream id updated-------------------Room: ", socket.room);
				console.log (roomMembers[socket.room][i]);
			}
		}
		
		// INFORM ALL THE USERS IN THE ROOM ABOUT THE CHANGE IN USER'S STREAM ID.
		socket.broadcast.to (socket.room).emit ("message", {
			type: "changeStreamIdMsg",
			old: data.old,
			streamId: data.streamId
		});
	});
	
	// WE WILL ONLY SERVE ONE PARTICIPANT PER ROOM AT A TIME. BECAUSE THIS FUNCTION WILL CALCULATE STREAMORDER
	// ETC SO  TO AVOID CONFLICTS WE WILL ADD OTHER REQUEST TO QUEUE AND ONCE SERVED WE WILL REMOVE THEM FROM QUEUE.
	socket.on ('login', function (data)
	{
		console.log("code35, new login request ",data.streamId);
		let queued = false;
		if(typeof serving[data.room] !== "undefined")
		{
			if(serving[socket.room]);
			{
				console.log("code35, service another, putting in queue ",data.streamId);
				queued = true;
			}
		}
		// let intervalQueue = setInterval(()=>
		// {
		// 	if(!queued)
		// 	{
		// 		// LETS CLEAR THE INTERVAL
		// 		clearInterval(intervalQueue);
				// console.log("code35, queue is free, now serving ",data.streamId);
				// LETS PUT IT IN QUEUE
				serving[data.room] = true;
				console.log ('========== Client Login: ' + data.streamId + '  ================');
				console.log (data);
				// socket.id = data.streamId;
				if (data.userType === 'host')
				{
					hostSocket = socket.id;
					roomHostsSockets[data.room] = socket.id;
				}
				socket.streamId = data.streamId;
				
				// ROOM NAME WILL CONSIST OF WORD "room" AND ROOM_ID.
				socket.room = data.room;
				socket.join (data.streamId);
				socket.join (data.room);
				
				console.log ("===room members now===", roomMembers);
				
				// DONT NEED TO VALIDATE USER NAME. THE APP WILL ASSIGN NEW IDENTITY LETTER TO THE USER.
				// THIS WILL WORK FOR INACTIVE USERS. ACTIVE USERS WE ARE STILL SHOWING THE NAME.
				// SO DUPLICATE NAMES WILL BE DISPLAYED FOR ACTIVE USERS.



				// VALIDATE USERNAME, CHECK IF THIS USERNAME DOES NOT ALREADY EXIST.
				if (typeof roomMembers[socket.room] !== "undefined")
				{
					// IF THIS USER IS TRYING TO LOGIN AS HOST, THEN WE WILL CHECK IF THERE IS NOT ALREADY AN ACTIVE
					// HOST IN THE ROOM.
					if(data.userType === "host")
					{
						let hosts = roomMembers[socket.room].filter (x => x.userType === "host");
						if (hosts && hosts.length > 0)
						{
							socket.emit ("message", {type: "host_already_exist", hosts: hosts});
							return false;
						}
					}
				}
				
				// IF THIS IS NOT THE HOST, WE WILL CHECK THE USER TYPE.
				if(data.userType != "host")
				{
					// GET THE ACTIVE PARTICIPANTS IN ROOM.
					let participants = [];
					if (typeof roomMembers[socket.room] !== "undefined")
					{
						participants = roomMembers[socket.room].filter (x => x.userType == "participant");
					}
					
					// SET THIS USER'S USER TYPE, WHETHER THEY ARE ACTIVE OR INACTIVE.
					// FIRST SV-ROOM-MAXPARTICIPANTS - 1 PARTICIPANTS SHOULD BE LOCKED.
					if (participants.length < siteVariables['SV-ROOM-MAXPARTICIPANTS'].value - 2)
					{
						data.lockState = "live";
					}
					
					// IF MAXIMUM PARTICIPANT LIMIT, THAT IS 2 or 5, IS NOT REACHED THEN WE WILL ADD NEW USER AS PARTICIPANT
					// OTHERWISE IT WILL BE A LISTENER.
					if (participants.length >= siteVariables['SV-ROOM-MAXPARTICIPANTS'].value - 1)
					{
						data.userType = "listener";
					} else
					{
						// IF USER IS NOT ALREADY LISTENER, DUE TO SOME LIMITATION.
						if(data.userType != "listener")
						{
							data.userType = "participant";
						}
					}
				}
				
				// REMOVE ANY DUPLICATE USERNAME IF EXIST.
				// roomMembers[socket.room] = roomMembers[socket.room].filter(element=>element.username !== data.username);
				
				// CALCULATE THE STREAMORDER OF USER. STREAMORDER IS WHERE USER'S STREAM WOULD DISPLAY IN ROOM.
				//data.streamOrder = calculateStreamOrder(socket.room, data);
				
				console.log ("code30, stream display order: ", data.streamOrder);
				
				//sendback(socket, { type: 'welcome', id: socket.id });
				
				// INFORM ALL THE USERS IN ROOM ABOUT NEW USER.
				socket.broadcast.to (data.room).emit ("message", {type: "new_user_login", data: data.streamId, info: data});
				
				if (!roomMembers[socket.room])
				{
					roomMembers[socket.room] = [];
				}
				
				roomMembers[socket.room].push (data);
				
				console.log ("update room members now");
				updateRoomMembers (socket);
				
				setStreamOrder(socket.room);
				let streamOrder = getStreamOrder (socket);
				console.log ("-------------emiting loggedIn --------------");
				
				// SEND DATA TO USER WHO INITIATED LOGIN FUNCTION, WE CAN SEND ANY DATA THAT USER MAY REQUIRE.
				socket.emit ("login_data", {streamOrder: streamOrder,data:data, roomMembers: roomMembers[socket.room]});
				
				// if (interval_registered.indexOf (socket.streamId) === -1)
				// {
				// 	setInterval (function ()
				// 	{
				// 		io.sockets.to (socket.streamId).emit ("message", {
				// 			type: "refresh_user_list",
				// 			data: roomMembers[socket.room]
				// 		});
				// SEND PING TO ALL CONNECTED PRODUCES AND IF THEY REPOND PONG THEN SKIP IT, OTHERWISE WE WILL HAVE TO
				// INVESTIGATE ON THEIR CONNECTIVITY STATUS.
				//console.log("-------------------sending ping----------------");
				// getHeartBeat(socket).then( data =>
				// {
				// 	console.log("sending ping ", data);
				// }).catch( (error)=>
				// {
				// 	console.log("ping error", error);
				// });
				//    }, 5000);
				// 	interval_registered.push (socket.streamId);
				// }
				
		// 	}
		// 	else
		// 	{
		// 		console.log("code35, still in queue ",data.streamId);
		// 	}
		// }, 200);
	});
	
	// UPDATING STATE OF WHETHER TO AUTO PLAY USER STREAM OR NOT. WE KEEP CHECKING IF THE USER STREAM IS PLAYING OR
	// NOT, AND IF THEY ARE NOT WE WILL TRY TO AUTO PLAY IT, BUT SOMETIMES WE DONT WANT SYSTEM TO AUTO PLAY USERS
	// STREAMS, IN THAT CASE WE CAN UPDATE VALUE OF AUTO PLAY PROPERTY OF USER OBJECT.
	socket.on("update_auto_play_state", function (data)
	{
		if(typeof roomMembers[socket.room] !== "undefined")
		{
			console.log("----------------update_auto_play_state--------------");
			let userToUpdate = roomMembers[socket.room].find(element => element.streamId == data.stream_id);
			if(userToUpdate)
			{
				console.log (userToUpdate);
				console.log (roomMembers[socket.room]);
				console.log (data);
				userToUpdate.autoPlay = data.autoPlay;
			}
		}
	});
	
	// THIS CODE SECTION WILL BE EXECUTED WHEN WE ARE UPDATING A PROPERTY IN ROOM USERS ARRAY.
	socket.on("update_room_users_array", function(data){
		let updatingUser = roomMembers[socket.room].find(element => element.streamId == data.streamId);
		updatingUser.username = data.username;
		
		// SEING NOTIFICATION TO ROOM SO WE CAN UPDATE VAIRABLES FOR ALL USERS.
		socket.broadcast.to (socket.room).emit ("message", {type: "room_users_array_has_updated", data: data});
	});
	
	// RESPONDING TO REQUEST TO SEND LIST OF ROOM USERS.
	socket.on("get_list_of_room_users", function (room_id)
	{
		console.log("============list_of_room_users===========");
		if(typeof roomMembers['room_'+room_id] !== "undefined")
		{
			console.log (room_id, roomMembers['room_' + room_id]);
			socket.emit ("list_of_room_users", roomMembers['room_' + room_id]);
		}
	});
	
	// WHEN A USER IS GONE FROM THE ROOM, WE NEED TO REMOVE THEM FROM ACTIVE USERS LIST AND ALSO INFORM IT IN ROOM
	// SO REQUIRED ACTIONS CAN BE TAKEN.
	socket.on ('disconnect', function ()
	{
		cleanUpPeer(socket);
		console.log ('Client  ' + socket.handshake.address + '  disconnected.room '+socket.room);
		console.log(roomMembers);
		if (roomMembers[socket.room])
		{
			for (j = 0; j < roomMembers[socket.room].length; j++)
			{
				
				// LOOP THROUGH ARRAY TO FIND THE USER INFO WHO HAS LEFT.
				if (roomMembers[socket.room][j].streamId == socket.streamId)
				{
					
					// SEND THE LEFT USER'S INFO TO THE ROOM.
					io.to (socket.room).emit ("message", {
						type: "user_left",
						data: socket.streamId,
						info: roomMembers[socket.room][j]
					});
					break;
				}
			}
			roomMembers[socket.room] = roomMembers[socket.room].filter(x=>x.streamId !== socket.streamId);
			updateRoomMembers (socket);
			console.log ("=================Disconnect " + socket.streamId + ", room: " + socket.room + " clients=================");
			console.log("members now");
			console.log (roomMembers[socket.room]);
		}
	});
	
	// SENDING MESSAGE TO HOST OF THE ROOM
	socket.on("message_to_host", function(data)
	{
		io.sockets.to (roomHostsSockets[socket.room]).emit("message_for_host", data);
	});
	
	// GET LIST OF USERS IN THE ROOM
	socket.on ('getRoomClients', function ()
	{
		console.log ("=================getRoomClients=================");
		// console.log (roomMembers[socket.room],socket.room);
		io.sockets.to (socket.streamId).emit ("message", {type: "get_user_list", data: roomMembers[socket.room]});
	});
	
	// CHANGING USER TYPE FROM LISTENER TO PARTICIPANT OR VICE VERSA. WILL BE DONE WHEN HOST IS ADDING OR REMOVING A
	// PARTICIPANT.
	socket.on ('change_user_type', function (data)
	{
		console.log ("---------change_user_type--------");
		// console.log (data);
		console.log("socket.room ", socket.room);
		if(roomMembers[socket.room])
		{
			for (var i = 0; i < roomMembers[socket.room].length; i++)
			{
				if (roomMembers[socket.room][i].streamId == data.streamId)
				{
					roomMembers[socket.room][i].userType = data.userType;
					
					// IF STREAM ORDER IS AVAILABLE IN DATA, THEN WE WILL UPDATE STREAM ORDER IN ROOMMEMBER ARRAY.
					if(typeof data.streamOrder !== "undefined" && data.streamOrder != "undefined" && data.streamOrder != -1 )
					{
						roomMembers[socket.room][i].streamOrder = data.streamOrder;
					}
				}
			}
		}
		console.log ("-----------change_user_type roomMembers----------");
		// console.log (roomMembers);
		
		// LETS SEND MESSAGE TO ROOM, THAT THIS USER'S TYPE HAS CHANGED SO THIS USER TYPE IN THE VARIABLES CAN BE
		// UPDATED.
		socket.broadcast.to (socket.room).emit ("message", {type: "usertype_has_changed_in_room", data: data});
	});
	
	// THIS REQUEST WILL PAUSE AUDIO PRODUCER OF THE CURRENT USER.
	socket.on('pauseAudioProducer', async (data, callback) =>
	{
		pauseProducer(socket.streamId, "audio", socket);
		sendResponse(true, callback);
	});
	
	// THIS REQUEST WILL PAUSE AUDIO PRODUCER OF THE CURRENT USER.
	socket.on('resumeAudioProducer', async (data, callback) =>
	{
		resumeProducer(socket.streamId, "audio", socket);
		sendResponse(true, callback);
	});
	
	// THIS REQUEST WILL BE CREATED FROM PARTICIPANT THAT IS BEING CONVERTED INTO INACTIVE ONE.
	socket.on("pause_producer", function()
	{
		pauseProducer(socket.streamId, "audio", socket);
		pauseProducer(socket.streamId, "video", socket);
	});
	
	// THIS REQUEST WILL BE CREATED FROM PARTICIPANT THAT IS BEING CONVERTED INTO INACTIVE ONE.
	socket.on("resume_producer", function(data)
	{
		if(data.streamOrder)
		{
			// IT WILL ONLY BE PRESENT IF WE ARE SWAPPING USERS, WE NEED THIS STREAM ORDER INFORMATION SO WE CAN
			// SWAP USER IN THE PLACE OR OLD USER.
			socket.streamOrder = data.streamOrder;
		}
		resumeProducer(socket.streamId, "audio", socket);
		resumeProducer(socket.streamId, "video", socket);
	});
	
	// THIS REQUEST THAT WILL BE STOPPING PRODUCER, WE WILL BE USING IT TO STOP SCREEN.
	socket.on("stop_screen_producer", function()
	{
		removeProducer(socket.streamId, "screen", socket);
	});
	
	// THIS REQUEST THAT WILL BE PAUSING PRODUCER, WE WILL BE USING IT TO PAUSE SCREEN.
	socket.on("pause_screen_producer", function()
	{
		pauseProducer(socket.streamId, "screen", socket);
	});
	// THIS REQUEST THAT WILL BE RESUMING PRODUCER, WE WILL BE USING IT TO RESUME SCREEN.
	socket.on("resume_screen_producer", function()
	{
		resumeProducer(socket.streamId, "screen", socket);
	});
	
	// THIS CODE WILL BE EXECUTED WHEN HOST CLICKS ON LOCK, WE WILL TAKE ACTION WHETHER TO LOCK THE ROOM CHAT OR
	// UNLOCK IT.
	socket.on("update_lock_chat_state", function (data)
	{
		socket.emit("lock_room_chat", data);
		if(typeof roomSettings[socket.room] === "undefined")
		{
			roomSettings[socket.room] = {};
		}
		if(data.chatType == "public")
		{
			roomSettings[socket.room].public_chat = data.state;
		}
		else
		{
			roomSettings[socket.room].private_chat = data.state;
		}
		
		// SENT THE LOCK STATE TO ALL PARTICIPANT OF ROOM SO WE WE CAN BLOCK/UNBLOCK CHAT FOR THEM.
		socket.broadcast.to (socket.room).emit("message",data);
	});
	
	// THIS CODE WILL BE EXECUTED WHEN HOST CLICKS ON LOCK FEEDBACK BUTTONS, WE WILL TAKE ACTION WHETHER TO LOCK THE
	// ROOM FEEDBACK BUTTONS OR UNLOCK THEM.
	socket.on("update_lock_feedback_state", function (data)
	{
		// IF ROOM SETTINGS ARRAY DOES NOT EXIST THEN CREATE IT FOR CURRENT ROOM.
		if(typeof roomSettings[socket.room] === "undefined")
		{
			roomSettings[socket.room] = {};
		}
		roomSettings[socket.room].feedback_state = data.state;
		
		// SENT THE LOCK STATE TO ALL PARTICIPANT OF ROOM SO WE WE CAN BLOCK/UNBLOCK FEEDBACK BUTTONS FOR THEM.
		socket.broadcast.to (socket.room).emit("message",data);
	});
	
	// UPDATE VIDEO INFORMATION IN USER ARRAY, IF USER TURNS ON THE VIDEO, WE NEED TO UPDATE IN THE USERS ARRAY.
	socket.on ('update_video_info', function (data)
	{
		console.log ("---------update_video_info--------");
		console.log (data);
		if(roomMembers[socket.room])
		{
			for (var i = 0; i < roomMembers[socket.room].length; i++)
			{
				if (roomMembers[socket.room][i].streamId == data.streamId)
				{
					roomMembers[socket.room][i].cameraState = data.cameraState;
					if(data.cameraState == "live")
					{
						roomMembers[socket.room][i].hasWebcam = true;
					}
				}
			}
		}
		console.log ("-----------change_user_type roomMembers----------");
		console.log (roomMembers);
		io.sockets.to (data.streamId).emit ("message", {type: "relogin_usertype_changed", data: data});
	});
	
	// SENDING MESSAGE IN A ROOM IF ANY USER'S TYPE HAS CHANGED. SO THEIR STREAM CAN BE STARTED OR CLOSED DEPENDING
	// UPON THEIR TYPE.
	socket.on ('change_user_type_in_room', function (data)
	{
		socket.broadcast.to (socket.room).emit ("message", {type: "type_change_across_room", data: data});
	});
	
	socket.on("update_icbutton_state", function(data)
	{
		if(typeof roomMembers[socket.room] !== "undefined")
		{
			let luser = roomMembers[socket.room].find (element => element.streamId == data.streamId);
			if (typeof data !== "undefined" && typeof data.icAttribute !== "undefined")
			{
				switch (data.icAttribute)
				{
					case "mic":
						luser.micState = data.icState;
						break;
					case "camera":
						luser.cameraState = data.icState;
						break;
					case "lock":
						luser.lockState = data.icState;
						break;
					case "screen":
						luser.screenState = data.icState;
						break;
				}
			}
		}
	});
	
	// PERFORM ANY SET OF ACTIONS SENT BY HOST OR USERS THEMSELVES. JUST AN EASY WAY FOR THE FLOW OF DATA BETWEEN
	// TWO SOCKETS.
	socket.on ('perform_action', function (data)
	{
		console.log ("======================= perform action " + data.type);
		io.sockets.to (data.streamId).emit ("message", {type: data.type, data: data});
	});
	
	// GETTING DIAGNOSTICS DATA.
	socket.on("get_diagnostic_data", function(data)
	{
	
	});
	
	socket.on("save_diagnostic_data", function(data)
	{
		let diaUser = roomMembers[socket.room].find(element => element.streamId == data.stream_id);
		diaUser.diagnostics[data.property] = data.value;
	});
	
	// SEND USER'S CHAT MESSAGE IN ROOM
	socket.on ('sendChatMessage', function (data)
	{
		socket.broadcast.to (socket.room).emit ("message",
		{
			type: "send_chat_message",
			data: data
		});
		
		// SAVE ROOM CHAT IN roomChats VARIABLE, SO WE CAN HAVE A CHAT RECORD AND SHOW IT IF PAGE REFRESHES.
		if(typeof roomChats[socket.room] ==="undefined")
		{
			roomChats[socket.room] = [];
		}
		roomChats[socket.room].push(data);
	});
	
	// SEND PRIVATE CHAT MESSAGE IN ROOM
	socket.on ('sendPrivateChatMessage', function (data)
	{
		socket.to (data.message_to).emit ("message",
		{
			type: "send_private_chat_message",
			data: data
		});
		
		// SAVE ROOM CHAT IN privateRoomChats VARIABLE, SO WE CAN HAVE A CHAT RECORD AND SHOW IT IF PAGE REFRESHES.
		if(typeof privateRoomChats[socket.room] ==="undefined")
		{
			privateRoomChats[socket.room] = [];
		}
		privateRoomChats[socket.room].push(data);
	});
	
	// CLEARS THE CHAT ARRAY.
	socket.on("delete_chat_history", function (type)
	{
		// IF WE ARE DELETING PUBLIC CHAT, OTHERWISE IT WILL BE PRIVATE CHAT.
		if(type == "public")
		{
			// IF THERE IS CHAT IN ROOM
			if (typeof roomChats[socket.room] !== "undefined")
			{
				roomChats[socket.room] = [];
			}
		}
		else
		{
			// IF THERE IS PRIVATE CHAT IN ROOM
			if (typeof privateRoomChats[socket.room] !== "undefined")
			{
				privateRoomChats[socket.room] = [];
			}
		}
		
		
		// SEND COMMAND TO ALL ROOM USERS TO DELETE CHAT HISTORY AT THEIR END.
		socket.broadcast.to (socket.room).emit ("message",
		{
			type: "clear_chat_history",
			chatType: type
		});
	});
	
	// DISCONNECT A USER FROM THE ROOM.
	socket.on ('disconect_user', function (data)
	{
		removeMember (socket, data.streamId);
		
		// SEND RESPONSE TO THE SOCKET WHEN USER IS DISCONNECTED.
		socket.emit("user_disconnected", {});
	});
	
	// WE ARE TURNING ON USER'S CAMERA FOR THE FIRST TIME.
	socket.on("turnon_camera", function (data)
	{
		// REMOVE THE MEMBER FIRST,
		removeMember (socket, data.streamId);
		
		// NOW SEND RESPONSE TO THE CLIENT THAT HAS REQUESTED TO TURN OF CAMERA.
		socket.emit("turnon_camera_response", {success: true});
		
		// NOW NOTIFY MEMBERS IN ROOM TO CHANGE THE AUDIO CALL OF THE USER TO THE VIDEO CALL.
		socket.broadcast.to (socket.room).emit ("message",
		{
			type: "change_video_parameters",
			streamId: data.streamId
		});
	});
	
	// SEND ANY KIND OF DATA TO ROOM. JUST A EASY WAY FOR THE FLOW OF DATA IN THE ROOM.
	socket.on ('send_data_to_room', function (data)
	{
		socket.broadcast.to (socket.room).emit ("message", data);
		
		// IF sendMe IS FOUND, WE WILL ALSO SEND THIS MESSAGE TO CURRENT USER.
		if(typeof data.sendMe !== "undefined")
		{
			socket.emit("message", data);
		}
	});
	
	// THIS WILL UPDATE ROOM MEMBERS ARRAY ON SERVER.
	socket.on('update_user_role_class', function(data)
	{
		if(typeof roomMembers[socket.room] !== "undefined")
		{
			let urUser = roomMembers[socket.room].find(x => x.streamId == data.streamId);
			if(urUser)
			{
				urUser.userRoleClass = data.roleClass;
			}
		}
	});
	
	// SENDING ANY MESSAGE TO ROOM.
	socket.on ('message', function (data)
	{
		console.log ("emiting to room : ", data.data.roomName);
		socket.broadcast.to (data.data.roomName).emit ('pingScreen', data);
	});
	
	// WHEN USER REQUESTS A SCREEN SHARE, SEND THIS REQUEST TO ROOM SO HOST CAN TAKE ACTION.
	socket.on ("share_screen_request", function (user)
	{
		socket.broadcast.to (user.room).emit ("sharescreen_req_received", user);
	});
	
	// HOST IS ASKING QUESTION TO PARTICIPANTS.
	socket.on ('sendQuestion', function (data)
	{
		data.socketId = socket.id;
		socket.broadcast.to (data.roomName).emit ('recieveQuestion', data);
	});
	
	// PARTICIPANT IS ASKING QUESTION TO HOST.
	socket.on ('requestQuestion', function (data)
	{
		data.socketId = socket.id;
		io.sockets.to (hostSocket).emit ('recieveQuestion', data);
	});
	
	// HOST WILL SHARE ANY QUESTION ASKED BY PARTICIPANT IN THE ROOM.
	socket.on ('shareQuestion', function (data)
	{
		data.socketId = socket.id;
		socket.broadcast.to (data.roomName).emit ('recieveQuestion', data);
	});
	
	// SOMEONE ANSWERS THE QUESTION ASKED BY HOST.
	socket.on ('answerQuestion', function (data)
	{
		io.sockets.to (data.socketId).emit ('recieveAnswer', data);
	});
	
	// WHEN A SOCKET CONNECTS.
	socket.on ('connect', function ()
	{
		socket.broadcast.emit ('connect', data);
	});
	
	// GET LIST OF USERS IN THE ROOM.
	socket.on ('getUserManagement', function ()
	{
		console.log("----------getUserManagement-------",roomMembers[socket.room]);
		console.log("---------------------------");
		io.sockets.to (socket.room).emit ("userManagement", {info: roomMembers[socket.room]});
	});
	
	// FUNTION TO CALCULATE AND RETURN STREAM ORDER OF GIVEN STREAM ID.
	socket.on('getUserStreamOrder', (data, callback) =>
	{
		setStreamOrder(socket.room);
		callback(getUserStreamOrder(socket,data.streamId), null);
	});
	
	// FUNTION TO RETURN ROOM USERS.
	socket.on('getRoomUsers', (data, callback) =>
	{
		console.log("-----------------------------------------------roomMembers[socket.room]-------",
			data.room, roomMembers);
		callback({ data: roomMembers[data.room]}, null);
	});
	
	// FUNTION TO GET USER OBJECT FROM ROOM MEMBERS ARRAY.
	socket.on('getUserCameraState', (data, callback) =>
	{
		let userObj = roomMembers[socket.room].find(x => x.streamId == data.streamId);
		callback(userObj.cameraState, null);
	});
	
	socket.on('getProducerStats',async (data, callback)=>
	{
		try
		{
			// let producer = getProducerTrasnport(getId(socket));
			// let producerStats = await producer.getStats();
			let GPSid = getId (socket);
			const videoProducer = getProducer (GPSid, 'video', socket);
			const audioProducer = getProducer (GPSid, 'audio', socket);
			let vProducerStats;
			let aProducerStats;
			if (videoProducer)
			{
				vProducerStats = await videoProducer.getStats ();
			}
			if (audioProducer)
			{
				aProducerStats = await audioProducer.getStats ();
			}
			callback ({audio: aProducerStats, video: vProducerStats}, null);
		}
		catch (e)
		{
			console.log("producer not found");
			callback (false, null);
		}
	});
	
	socket.on('getConsumerStats',async (data, callback)=>
	{
		try
		{
			let GCSid = getId (socket);
			let consumerInfo = getConsumer (GCSid, data.remoteId, data.type);
			let consumerStats;
			if (consumerInfo)
			{
				consumerStats = await consumerInfo.getStats ();
			}
			callback ({stats: consumerStats}, null);
		}
		catch (e)
		{
			console.log("consumer not available: ",data.remoteId , data.type);
			socket.emit("close_stats",{streamId: data.remoteId, trackKind: data.type});
			callback (false, null);
		}
	});
	
	
	// MEDIA SOUP SOCKET LISTENERS
	socket.on('error', function (err)
	{
		console.error('socket ERROR:', err);
	});
	socket.on('connect_error', (err) =>
	{
		console.error('client connection error', err);
	});
	
	socket.on('getRouterRtpCapabilities', (data, callback) =>
	{
		if (router) {
			//console.log('getRouterRtpCapabilities: ', router.rtpCapabilities);
			sendResponse(router.rtpCapabilities, callback);
		}
		else {
			sendReject({ text: 'ERROR- router NOT READY' }, callback);
		}
	});
	
	// IF WE WANT TO CLOSE ANY PRODUCER WE CAN CALL THIS.
	socket.on('closeProducer', async (data, callback) =>
	{
		const id = getId(socket);
		const videoProducer = getProducer(id, 'video', socket);
		if (videoProducer)
		{
			videoProducer.close();
			removeProducer(id, 'video',socket);
		}
		const audioProducer = getProducer(id, 'audio', socket);
		if (audioProducer)
		{
			audioProducer.close();
			removeProducer(id, 'audio', socket);
		}
		removeProducerTransport(id);
		
		// NOTIFY PEOPLE IN ROOM THAT THE CONNECTION IS CLOSED FOR ONE OF THE PARTICIPANTS.
		socket.broadcast.to (socket.room).emit ("producerHasClosed",
		{
			kind: "both",
			streamId: socket.streamId,
			producedTrackKind: data.state
		});
		
		sendResponse(true, callback);
	});
	
	// IF WE WANT TO CLOSE VIDEO PRODUCER WE CAN CALL THIS.
	socket.on('closeVideoProducer', async (data, callback) =>
	{
		const id = getId(socket);
		const videoProducer = getProducer(id, 'video', socket);
		if (videoProducer)
		{
			videoProducer.close();
			removeProducer(id, 'video',socket);
		}
		sendResponse(true, callback);
	});
	
	socket.on('closeScreenProducer', async (data, callback) =>
	{
		const id = getId(socket);
		const screenProducer = getProducer(id, 'screen', socket);
		if (screenProducer)
		{
			screenProducer.close();
			removeProducer(id, 'screen',socket);
		}
		sendResponse(true, callback);
	});
	
	// IF WE WANT TO CLOSE ANY PRODUCER WE CAN CALL THIS.
	socket.on('closeConsumer', async (data, callback) =>
	{
		const localId = getId(socket);
		removeConsumerSetDeep(localId);
		console.log("tranport.observer.close-----consumerHasclosed");
		removeConsumerTransport(localId);
		sendResponse(true, callback);
	});
	
	// CLOSING VIDEO CONSUMERS
	socket.on('closeVideoConsumer', async (data, callback) =>
	{
		const localId = getId(socket);
		removeVideoConsumer(localId);
		sendResponse(true, callback);
	});
	
	// CLOSING SPECIFIC CONSUMERS
	socket.on('closeSingleConsume', async (data, callback) =>
	{
		const myLocalId = getId(socket);
		const consumeVideo = getConsumer(myLocalId, data.streamId, "video");
		const consumeAudio = getConsumer(myLocalId, data.streamId, "audio");
		if(consumeVideo)
		{
			consumeVideo.close ();
		}
		if(consumeAudio)
		{
			consumeAudio.close ();
		}
		sendResponse(true, callback);
	});
	
	socket.on('createProducerTransport', async (data, callback) =>
	{
		console.log('-- createProducerTransport ---');
		try
		{
			const { transport, params } = await createTransport();
			if(transport)
			{
				addProducerTrasport (getId (socket), transport);
				transport.observer.on ('close', () =>
				{
					console.log ("----------producer transport close-----------");
					const id = getId (socket);
					const videoProducer = getProducer (id, 'video', socket);
					if (videoProducer)
					{
						videoProducer.close ();
						removeProducer (id, 'video', socket);
					}
					const audioProducer = getProducer (id, 'audio', socket);
					if (audioProducer)
					{
						audioProducer.close ();
						removeProducer (id, 'audio', socket);
					}
					removeProducerTransport (id);
				});
			}
			sendResponse(params, callback);
		}
		catch (e)
		{
			console.log("error on createProducerTransport: ", e);
		}
		//console.log('-- createProducerTransport params:', params);
	});
	
	socket.on('connectProducerTransport', async (data, callback) => {
		const transport = getProducerTrasnport(getId(socket));
		await transport.connect({ dtlsParameters: data.dtlsParameters }).then().catch(error=>
		{
			console.log("code25, connectProducerTransport. ", error);
		});
		sendResponse({}, callback);
	});
	
	socket.on('produce', async (data, callback) =>
	{
		const { kind, rtpParameters,appData } = data;
		const id = getId(socket);
		console.log('code25, -- produce --- kind= | ' + kind + ' - ' + id);
		const transport = getProducerTrasnport(id);
		if (!transport) {
			console.error('transport NOT EXIST for id=' + id);
			return;
		}
		let producer = await transport.produce({ kind, rtpParameters,appData }).then().catch(error =>
		{
			console.log("code25, producer error", error);
			console.log(rtpParameters);
			sendResponse ({id: 0,success: false}, callback);
		});
		if(producer)
		{
			let producedTrackKind = kind;
			// IF WE HAVE TRACK KIND INFORMATION IN APP DATA VARIABLE THEN WE WILL PICK IT FROM THERE.
			if(typeof appData.producedTrackKind !== "undefined")
			{
				if(appData.producedTrackKind == "screen")
				{
					producedTrackKind = "screen";
				}
			}
			
			// setInterval( async ()=>
			// {
			// 	let stats = await producer.getStats();
			// 	socket.emit("producerStats", stats);
			// }, 10000);
			
			// IF producedTrackKind == SCREEN, THEN WE WILL CHECK IF THERE IS ALREADY ANY SCREEN SHARED OR NOT, IF
			// THERE IS THEN WE WILL SEND COMMAND TO THE USER WHO IS SHARING THE SCREEN TO STOP THEIR SCREEN AND
			// THEN WE WILL START NEW SCREEN SHARE, SO THERE IS ONLY ONE SCREEN SHARED IN A ROOM.
			if(producedTrackKind == "screen")
			{
				// CHECK IF THERE IS A SCREEN STREAM?
				console.log("code31, checking if there is any stream. ");
				if(typeof screenProducers[socket.room] !== "undefined")
				{
					console.log("code31, there is already a screen stream, we will close it first."+ screenProducers[socket.room].length);
					for(const screenKey in screenProducers[socket.room])
					{
						console.log("code31, running stream "+screenKey);
						io.sockets.to(screenKey).emit("message", {type: "stop_screen_share"});
					}
				}
				addProducer (id, producer, producedTrackKind, socket);
			}
			else
			{
				addProducer (id, producer, producedTrackKind, socket);
			}
			// addProducer (id, producer, producedTrackKind, socket);
			producer.observer.on ('close', () =>
			{
				console.log ('code25, producer closed --- kind=%s, producedTrackKind=%s', kind,producedTrackKind);
				socket.broadcast.to (socket.room).emit ("producerHasClosed",
				{
					kind: producer.kind,
					streamId: socket.streamId,
					producedTrackKind: producedTrackKind
				});
				socket.emit("closeMyProducer", {producedTrackKind:producedTrackKind});
			});
			
			producer.observer.on ('resume', () =>
			{
				console.log ('code29, producer resume --- kind=' + kind);
				socket.emit("producerResume",
				{
					kind: producer.kind,
					streamId: socket.streamId,
					producedTrackKind:producedTrackKind,
					streamOrder: (socket.streamOrder?socket.streamOrder:-1)
				});
				socket.broadcast.to (socket.room).emit ("producerHasResumed",
				{
					kind: producer.kind,
					streamId: socket.streamId,
					producedTrackKind:producedTrackKind,
					streamOrder: (socket.streamOrder?socket.streamOrder:-1)
				});
			});
			
			producer.observer.on ('pause', () =>
			{
				console.log ('code29, producer pause --- kind=%s, producedTrackKind=%s', kind,producedTrackKind);
				socket.emit("producerPause",
				{
					kind: producer.kind,
					streamId: socket.streamId,
					producedTrackKind:producedTrackKind
				});
				socket.broadcast.to (socket.room).emit ("producerHasPaused",
				{
					kind: producer.kind,
					streamId: socket.streamId,
					producedTrackKind: producedTrackKind
				});
			});
			
			producer.on ("transportclose", () =>
			{
				console.log ("code25, transport closed so producer closed");
			});
			
			producer.on ("trackended", () =>
			{
				console.log ("track ended");
			});
			
			sendResponse ({id: producer.id, success: true}, callback);
			
			// INFORM CLIENTS ABOUT NEW PRODUCER
			console.log ('code31 --broadcast newProducer ---', socket.room);
			let streamsOrder = getStreamOrderList (socket);
			socket.broadcast.to (socket.room).emit ('newProducer',
			{
				socketId: id,
				producerId: producer.id,
				kind: producer.kind,
				streamsOrder: streamsOrder,
				appData: producer.appData
			});
		}
	});
	
	// --- consumer ----
	socket.on('createConsumerTransport', async (data, callback) =>
	{
		console.log('-- createConsumerTransport -- id=' + getId(socket));
		try
		{
			const { transport, params } = await createTransport();
			addConsumerTrasport(getId(socket), transport);
			transport.observer.on('close', () =>
			{
				const localId = getId(socket);
				removeConsumerSetDeep(localId);
				console.log("tranport.observer.close-----consumerHasclosed");
				
				// DISABLING IT NOW, BECAUSE WE SOMETIME REFRESH THE CONNECTION WHERE WE DONT NEED THIS SOCKET TO BE
				// CALLED.
				// socket.emit("consumerClosed");
				//socket.broadcast.to(socket.room).emit("consumerHasclosed", {streamId: socket.streamId});
				
				/*
				let consumer = getConsumer(getId(socket));
				if (consumer) {
				  consumer.close();
				  removeConsumer(id);
				}
				*/
				removeConsumerTransport(id);
			});
			sendResponse(params, callback);
		}
		catch (e)
		{
			sendReject("App failed to create consumer transport", callback);
			console.log("error on createConsumerTransport ", e);
		}
	});
	
	socket.on('connectConsumerTransport', async (data, callback) =>
	{
		console.log('-- connectConsumerTransport -- id=' + getId(socket));
		let transport = getConsumerTrasnport(getId(socket));
		if (!transport) {
			console.error('transport NOT EXIST for id=' + getId(socket));
			return;
		}
		await transport.connect({ dtlsParameters: data.dtlsParameters }).then().catch(error=>
		{
			console.log("code25, connectConsumerTransport ", error);
		});
		sendResponse({}, callback);
	});
	
	socket.on('consume', async (data, callback) => {
		console.error('-- ERROR: consume NOT SUPPORTED ---');
		return;
	});
	
	socket.on('resume', async (data, callback) =>
	{
		console.error('-- ERROR: resume NOT SUPPORTED ---');
		return;
	});
	
	socket.on('getCurrentProducers', async (data, callback) =>
	{
		const clientId = data.localId;
		console.log('-- getCurrentProducers for Id=' + clientId);
		
		const remoteVideoIds = getRemoteIds(clientId, 'video', socket);
		console.log('-- remoteVideoIds: | ', remoteVideoIds);
		const remoteAudioIds = getRemoteIds(clientId, 'audio', socket);
		console.log('-- remoteAudioIds:', remoteAudioIds);
		
		// GETTING SCREEN IDS IF AVAILABLE.
		const remoteScreenIds = getRemoteIds(clientId, 'screen', socket);
		
		// GETTING THE STREAMS ORDER.
		let streamsOrder = getStreamOrderList(socket);
		
		console.log("-----------------------------------------streamsOrder ---------", streamsOrder);
		sendResponse(
		{
			streamsOrder: streamsOrder,
			remoteVideoIds: remoteVideoIds,
			remoteAudioIds: remoteAudioIds,
			remoteScreenIds: remoteScreenIds,
			streamsOrder: streamsOrder
		}, callback);
	});
	
	socket.on('consumeAdd', async (data, callback) =>
	{
		const localId = getId(socket);
		const kind = data.kind;
		const producedTrackKind = data.producedTrackKind;
		console.log('-- consumeAdd -- localId=%s kind=%s', localId, kind);
		
		let transport = getConsumerTrasnport(localId);
		if (!transport)
		{
			console.error('transport NOT EXIST for id=' + localId);
			return;
		}
		const rtpCapabilities = data.rtpCapabilities;
		const remoteId = data.remoteId;
		console.log('-- consumeAdd - localId= ' + localId + ' remoteId=' + remoteId + ' kind=' + producedTrackKind);
		const producer = getProducer(remoteId, producedTrackKind, socket);
		if (!producer)
		{
			console.error('producer NOT EXIST for remoteId=%s kind=%s', remoteId, producedTrackKind);
			console.log("checking producer existance for kind video:", (getProducer(remoteId, producedTrackKind, socket)?"exists":"Not exists"));
			return;
		}
		const { consumer, params } = await createConsumer(transport, producer, rtpCapabilities); // producer must exist before consume
		
		//subscribeConsumer = consumer;
		addConsumer(localId, remoteId, consumer, producedTrackKind); // TODO: MUST comination of  local/remote id
		console.log('addConsumer localId=%s, remoteId=%s, kind=%s', localId, remoteId, producedTrackKind);
		consumer.observer.on('close', () =>
		{
			console.log('consumer closed ---');
		});
		
		console.log('-- consumer ready ---');
		
		// setInterval( async ()=>
		// {
		// 	let statss = await consumer.getStats();
		// 	console.log("consumer stats");
		// 	console.log(statss);
		// }, 10000);
		
		
		sendResponse(params, callback);
	});
	
	socket.on('resumeAdd', async (data, callback) =>
	{
		const localId = getId(socket);
		const remoteId = data.remoteId;
		const kind = data.kind;
		const producedTrackKind = data.producedTrackKind;
		console.log('-- resumeAdd localId=%s remoteId=%s kind=%s', localId, remoteId, producedTrackKind);
		let consumer = getConsumer(localId, remoteId, producedTrackKind);
		if (!consumer)
		{
			console.error('consumer NOT EXIST for remoteId=' + remoteId);
			return;
		}
		await consumer.resume();
		sendResponse({}, callback);
	});
	// END OF MEDIASOUP SICKET LISTENERS
}

async function getHeartBeat(socket)
{
	return new Promise(((resolve) =>
	{
		socket.emit("ping", {}, (data)=>
		{
			resolve(data);
		});
	}));
}

function getStreamOrderList(socket)
{
	let room = socket.room;
	let streamOrderList = [];
	if (roomMembers[room])
	{
		for (j = 0; j < roomMembers[room].length; j++)
		{
			streamOrderList.push(roomMembers[room][j].streamOrder);
			console.log("-------------------streamOrder===========",roomMembers[room][j].streamOrder);
		}
	}
	console.log(streamOrderList);
	return streamOrderList;
}

// REMOVE A MEMBER FROM THE ROOM.
function removeMember (socket, streamId)
{
	if (roomMembers[socket.room])
	{
		for (j = 0; j < roomMembers[socket.room].length; j++)
		{
			if (roomMembers[socket.room][j].streamId == streamId)
			{
				socket.broadcast.to (socket.room).emit ("message", {
					type: "user_left",
					data: streamId,
					info: roomMembers[socket.room][j]
				});
				roomMembers[socket.room].splice (j, 1);
				break;
			}
		}
		updateRoomMembers (socket);
		console.log ("==============removeMember===Disconnect " + streamId + ", room: " + socket.room + " clients=================");
		console.log (roomMembers[socket.room]);
	}
	
	// REMOVE THIS USER FROM PRODUCERS AS WELL.
	removeProducer(streamId, "audio", socket);
	removeProducer(streamId, "video", socket);
}

function calculateStreamOrder(room, user)
{
	let order;
	
	// IF THIS USER IS HOST, THEN THEY WILL HAVE FIRST ORDER AND WE WILL HAVE TO RIGHT SHIFT ORDER OF ALL OTHER USERS.
	if(user.userType == "host")
	{
		order = 0;
		return order;
	}
	// IF USER IS NOT HOST, THEN WE CALCULATE THE BIGGEST ORDER NUMBER IN ROOM, THAT WE CAN DO BY GETTING THE ROOM
	// LENGTH.
	if(typeof roomMembers[room] !== "undefined")
	{
		return roomMembers[room].length;
	}
	else
	{
		return 0;
	}
}
function getUserStreamOrder(socket, streamId)
{
	if(typeof roomMembers[socket.room] !== "undefined")
	{
		let user = roomMembers[socket.room].find(x => x.streamId == streamId);
		if(user)
		{
			return user.streamOrder;
		}
		else
		{
			return -1;
		}
	}
	else
	{
		return -1;
	}
}

function getStreamOrder(socket)
{
	if(typeof roomMembers[socket.room] !== "undefined")
	{
		let user = roomMembers[socket.room].find(x => x.streamId == socket.streamId);
		if(user)
		{
			return user.streamOrder;
		}
		else
		{
			return -1;
		}
	}
	else
	{
		return -1;
	}
}

// FUNCTION THAT WILL LOOP THROUGH EACH ITEM IN ROOMMEMBERS ARRAY AND MAKE SURE THE STREAM ORDER IS SET CORRECTLY.
// WE WILL CALL THIS FUNCTION WHEN ANY USER LEAVES THE ROOM. STREAM ORDER WILL ONLY BE SET FOR ACTIVE USERS.
function setStreamOrder(room)
{
	if(typeof roomMembers[room] !== "undefined")
	{
		let startingPositionForParticipants = 0;
		let counter = 0;
		
		// IF THE HOST EXIST, WE WILL GIVE FIRST POSITION TO THEM OTHERWISE ANYOTHER USER WILL TAKE IT, AND WHEN
		// HOST JOINS WE WILL RE ASSIGN POSITIONS TO OTHER PARTICIPANTS.
		let host = roomMembers[room].find(x => x.userType == "host");
		if(host)
		{
			// IF HOST EXIST THEN THE STARTING POSITION FOR USERS WILL BE 1, HOST WILL GET THE FIRST POSITION.
			startingPositionForParticipants = 1;
			host.streamOrder = 0;
		}
		
		// LETS SET ORDER FOR ACTIVE PARTICIPANTS
		for (let i = 0; i < roomMembers[room].length; i++)
		{
			// IF USER IS ACTIVE THEN WE WILL PUT THE ORDER
			if(roomMembers[room][i].userType == "participant")
			{
				// IF THERE IS NO HOST, STREAMORDER WILL BE 0, OTHER WISE IT WILL START FROM ONE AND CONTINUE
				// INCREASING.
				let streamOrder = counter + startingPositionForParticipants;
				roomMembers[room][i].streamOrder = streamOrder;
				counter++;
			}
		}
		
		// LETS SET ORDER FOR IN ACTIVE PARTICIPANTS/LISTENERS
		for (let i = 0; i < roomMembers[room].length; i++)
		{
			// IF USER IS IN ACTIVE THEN WE WILL PUT THE ORDER
			if(roomMembers[room][i].userType == "listener")
			{
				// IF THERE IS NO HOST, STREAMORDER WILL BE 0, OTHER WISE IT WILL START FROM ONE AND CONTINUE
				// INCREASING.
				let streamOrder = counter + startingPositionForParticipants;
				roomMembers[room][i].streamOrder = streamOrder;
				counter++;
			}
		}
	}
}

// WHENEVER THERE IS AN UPDATE IN ROOM MEMBERS, WE NEED TO SEND THIS INFO IN THE ROOM.
function updateRoomMembers (socket)
{
	// LETS UPDATE STREAMS ORDER.
	setStreamOrder(socket.room);
	
	// SENDING NEW USERS INFORMATION TO ROOM.
	io.sockets.to (socket.room).emit ("userManagement", {info: roomMembers[socket.room]});
}

function cleanUpPeer(socket)
{
	const id = getId(socket);
	removeConsumerSetDeep(id);
	
	const transport = getConsumerTrasnport(id);
	if (transport)
	{
		transport.close();
		removeConsumerTransport(id);
	}
	
	const screenProducer = getProducer(id, 'screen', socket);
	if (screenProducer)
	{
		screenProducer.close();
		removeProducer(id, 'screen', socket);
	}
	
	const videoProducer = getProducer(id, 'video', socket);
	if (videoProducer)
	{
		videoProducer.close();
		removeProducer(id, 'video', socket);
	}
	const audioProducer = getProducer(id, 'audio', socket);
	if (audioProducer)
	{
		audioProducer.close();
		removeProducer(id, 'audio', socket);
	}
	
	const producerTransport = getProducerTrasnport(id);
	if (producerTransport) {
		producerTransport.close();
		removeProducerTransport(id);
	}
}

const mediasoupOptions =
{
	// WORKER SETTINGS
	worker:
	{
		rtcMinPort: 10000,
		rtcMaxPort: 10100,
		logLevel: 'error',
		logTags: [
			// 'info',
			// 'ice',
			// 'dtls',
			// 'rtp',
			// 'srtp',
			// 'rtcp',
		],
	},
	// Router settings
	router: {
		mediaCodecs:
			[
				{
					kind: 'audio',
					mimeType: 'audio/opus',
					clockRate: 48000,
					channels: 2
				},
				{
					kind: 'video',
					mimeType: 'video/VP8',
					clockRate: 90000,
					parameters:
						{
							'x-google-start-bitrate': 1000
						}
				},
			]
	},
	// WebRtcTransport settings
	webRtcTransport:
	{
		listenIps:
		[
			{ ip: process.env.ip, announcedIp: null }
		],
		enableUdp: true,
		enableTcp: true,
		preferUdp: true,
		maxIncomingBitrate: 1500000,
		initialAvailableOutgoingBitrate: 1000000,
	}
};

function sendResponse(response, callback)
{
	//console.log('sendResponse() callback:', callback);
	callback(null, response);
}

// SEND ERROR TO CLIENT
function sendReject(error, callback)
{
	callback(error.toString(), null);
}

function sendback(socket, message)
{
	socket.emit('message', message);
}

async function startWorker()
{
	const mediaCodecs = mediasoupOptions.router.mediaCodecs;
	worker = await mediasoup.createWorker(mediasoupOptions.worker);
	router = await worker.createRouter({ mediaCodecs });
	//producerTransport = await router.createWebRtcTransport(mediasoupOptions.webRtcTransport);
	console.log('-- mediasoup worker start. --');
	 // setInterval(async ()=>
	 // {
		// const usage = await worker.getResourceUsage();
		// console.log(usage);
	 // },
	 // 10000);
}

startWorker();

function getProducerTrasnport(id) {
	return producerTransports[id];
}

function addProducerTrasport(id, transport) {
	producerTransports[id] = transport;
	console.log('producerTransports count=' + Object.keys(producerTransports).length);
}

async function removeProducerTransport(id)
{
	if(typeof producerTransports[id] !== "undefined")
	{
		await producerTransports[id].close();
		delete producerTransports[id];
	}
	console.log('producerTransports count=' + Object.keys(producerTransports).length);
}

function getProducer(id, kind, socket)
{
	if (kind === 'screen')
	{
		if(typeof screenProducers[socket.room] !== "undefined")
		{
			return screenProducers[socket.room][id];
		}
	}
	if (kind === 'video')
	{
		if(typeof videoProducers[socket.room] !== "undefined")
		{
			return videoProducers[socket.room][id];
		}
	}
	else if (kind === 'audio')
	{
		if(typeof audioProducers[socket.room] !== "undefined")
		{
			return audioProducers[socket.room][id];
		}
	}
	else {
		console.warn('UNKNOWN producer kind=' + kind);
	}
}

function getRemoteIds(clientId, kind, socket) {
	let remoteIds = [];
	if (kind === 'screen')
	{
		for (const key in screenProducers[socket.room])
		{
			console.log("getRemoteIds key:", key, "clientId", clientId);
			if (key !== clientId)
			{
				remoteIds.push(key);
			}
		}
	}
	else if (kind === 'video')
	{
		for (const key in videoProducers[socket.room])
		{
			console.log("getRemoteIds key:", key, "clientId", clientId);
			if (key !== clientId)
			{
				remoteIds.push(key);
			}
		}
	}
	else if (kind === 'audio')
	{
		for (const key in audioProducers[socket.room])
		{
			if (key !== clientId)
			{
				remoteIds.push(key);
			}
		}
	}
	return remoteIds;
}

function addProducer(id, producer, kind, socket)
{
	if (kind === 'screen')
	{
		if(typeof screenProducers[socket.room] === "undefined")
		{
			screenProducers[socket.room] = [];
		}
		screenProducers[socket.room][id] = producer;
		console.log('screenProducers count=' + Object.keys(screenProducers[socket.room]).length);
	}
	else if (kind === 'video')
	{
		if(typeof videoProducers[socket.room] === "undefined")
		{
			videoProducers[socket.room] = [];
		}
		videoProducers[socket.room][id] = producer;
		console.log('videoProducers count=' + Object.keys(videoProducers[socket.room]).length);
		// console.log("videoProducers: ",videoProducers);
	}
	else if (kind === 'audio')
	{
		if(typeof audioProducers[socket.room] === "undefined")
		{
			audioProducers[socket.room] = [];
		}
		audioProducers[socket.room][id] = producer;
		console.log('audioProducers count=' + Object.keys(audioProducers[socket.room]).length);
	}
	else
	{
		console.warn('UNKNOWN producer kind=' + kind);
	}
}

function removeProducer(id, kind, socket)
{
	if (kind === 'screen')
	{
		if(typeof screenProducers[socket.room] !== "undefined" && typeof screenProducers[socket.room][id] !== "undefined")
		{
			screenProducers[socket.room][id].close ();
			delete screenProducers[socket.room][id];
			console.log ('remove screenProducers count=' + Object.keys (screenProducers[socket.room]).length);
		}
	}
	else if (kind === 'video')
	{
		if(typeof videoProducers[socket.room] !== "undefined" && typeof videoProducers[socket.room][id] !== "undefined")
		{
			videoProducers[socket.room][id].close ();
			delete videoProducers[socket.room][id];
			console.log ('videoProducers count=' + Object.keys (videoProducers[socket.room]).length);
		}
	}
	else if (kind === 'audio')
	{
		if(typeof audioProducers[socket.room] !== "undefined" && typeof audioProducers[socket.room][id] !== "undefined")
		{
			audioProducers[socket.room][id].close ();
			delete audioProducers[socket.room][id];
			console.log ('audioProducers count=' + Object.keys (audioProducers[socket.room]).length);
		}
	}
	else
	{
		console.warn('UNKNOWN producer kind=' + kind);
	}
}

function pauseProducer(id, kind, socket)
{
	if (kind === 'screen')
	{
		if(typeof screenProducers[socket.room] !== "undefined" && typeof screenProducers[socket.room][id] !== "undefined")
		{
			screenProducers[socket.room][id].pause ();
			console.log ('code29, screenProducers paused');
		}
	}
	if (kind === 'video')
	{
		if(typeof videoProducers[socket.room] !== "undefined" && typeof videoProducers[socket.room][id] !== "undefined")
		{
			videoProducers[socket.room][id].pause ();
			console.log ('code29, videoProducers paused');
		}
	}
	else if (kind === 'audio')
	{
		if(typeof audioProducers[socket.room] !== "undefined" && typeof audioProducers[socket.room][id] !== "undefined")
		{
			audioProducers[socket.room][id].pause ();
			console.log ('code29, audioProducers paused');
		}
	}
	else
	{
		console.warn('UNKNOWN producer kind=' + kind);
	}
}

function resumeProducer(id, kind, socket)
{
	if (kind === 'screen')
	{
		if(typeof screenProducers[socket.room] !== "undefined" && typeof screenProducers[socket.room][id] !== "undefined")
		{
			screenProducers[socket.room][id].resume ();
			console.log ('code29, screenProducers resumed');
		}
	}
	if (kind === 'video')
	{
		if(typeof videoProducers[socket.room] !== "undefined" && typeof videoProducers[socket.room][id] !== "undefined")
		{
			videoProducers[socket.room][id].resume ();
			console.log ('code29, videoProducers resumed');
		}
	}
	else if (kind === 'audio')
	{
		if(typeof audioProducers[socket.room] !== "undefined" && typeof audioProducers[socket.room][id] !== "undefined")
		{
			audioProducers[socket.room][id].resume ();
			console.log ('code29, audioProducers resumed');
		}
	}
	else
	{
		console.warn('UNKNOWN producer kind=' + kind);
	}
}

function getConsumerTrasnport(id)
{
	if(typeof consumerTransports[id] !== "undefined")
	{
		return consumerTransports[id];
	}
	else
	{
		return false;
	}
}

function addConsumerTrasport(id, transport)
{
	consumerTransports[id] = transport;
	console.log('consumerTransports count=' + Object.keys(consumerTransports).length);
}

async function removeConsumerTransport(id)
{
	if(typeof consumerTransports[id] !== "undefined")
	{
		await consumerTransports[id].close();
	}
	delete consumerTransports[id];
	console.log('consumerTransports count=' + Object.keys(consumerTransports).length);
}

function getConsumerSet(localId, kind)
{
	if (kind === 'screen')
	{
		return screenConsumers[localId];
	}
	if (kind === 'video')
	{
		return videoConsumers[localId];
	}
	else if (kind === 'audio')
	{
		return audioConsumers[localId];
	}
	else
	{
		console.warn('WARN: getConsumerSet() UNKNWON kind=%s', kind);
	}
}
function getConsumer(localId, remoteId, kind)
{
	const set = getConsumerSet(localId, kind);
	if (set)
	{
		return set[remoteId];
	}
	else
	{
		return null;
	}
}

function addConsumer(localId, remoteId, consumer, kind)
{
	const set = getConsumerSet(localId, kind);
	if (set)
	{
		set[remoteId] = consumer;
		console.log('consumers kind=%s count=%d', kind, Object.keys(set).length);
	}
	else
	{
		console.log('new set for kind=%s, localId=%s', kind, localId);
		const newSet = {};
		newSet[remoteId] = consumer;
		addConsumerSet(localId, newSet, kind);
		console.log('consumers kind=%s count=%d', kind, Object.keys(newSet).length);
	}
}

function removeConsumer(localId, remoteId, kind)
{
	const set = getConsumerSet(localId, kind);
	if (set)
	{
		delete set[remoteId];
		console.log('consumers kind=%s count=%d', kind, Object.keys(set).length);
	}
	else
	{
		console.log('NO set for kind=%s, localId=%s', kind, localId);
	}
}

async function removeVideoConsumer(localId)
{
	console.log("removeVideoConsumer video consumer");
	const videoSet = getConsumerSet(localId, 'video');
	delete videoConsumers[localId];
	if (videoSet)
	{
		for (const key in videoSet)
		{
			const consumer = videoSet[key];
			console.log("closing video consumer");
			await consumer.close();
			delete videoSet[key];
		}
		console.log('removeConsumerSetDeep video consumers count=' + Object.keys(videoSet).length);
	}
}

function removeConsumerSetDeep(localId)
{
	const screenSet = getConsumerSet(localId, 'screen');
	delete screenConsumers[localId];
	if (screenSet)
	{
		for (const key in screenSet)
		{
			const consumer = screenSet[key];
			consumer.close();
			delete screenSet[key];
		}
		console.log('removeConsumerSetDeep screen consumers count=' + Object.keys(screenSet).length);
	}
	
	removeVideoConsumer(localId);
	
	const audioSet = getConsumerSet(localId, 'audio');
	delete audioConsumers[localId];
	if (audioSet)
	{
		for (const key in audioSet) {
			const consumer = audioSet[key];
			consumer.close();
			delete audioSet[key];
		}
		
		console.log('removeConsumerSetDeep audio consumers count=' + Object.keys(audioSet).length);
	}
}

function addConsumerSet(localId, set, kind) {
	if (kind === 'screen')
	{
		screenConsumers[localId] = set;
	}
	else if (kind === 'video')
	{
		videoConsumers[localId] = set;
	}
	else if (kind === 'audio')
	{
		audioConsumers[localId] = set;
	}
	else
	{
		console.warn('WARN: addConsumerSet() UNKNWON kind=%s', kind);
	}
}

async function createTransport()
{
	const transport = await router.createWebRtcTransport(mediasoupOptions.webRtcTransport);
	console.log('-- create transport id=' + transport.id);
	
	transport.on("routerclose", () =>
	{
		console.log("router closed so transport closed");
	});
	
	return {
		transport: transport,
		params: {
			id: transport.id,
			iceParameters: transport.iceParameters,
			iceCandidates: transport.iceCandidates,
			dtlsParameters: transport.dtlsParameters
		}
	};
}

function getId(socket)
{
	return socket.streamId;
}

async function createConsumer(transport, producer, rtpCapabilities) {
	let consumer = null;
	if (!router.canConsume(
	{
		producerId: producer.id,
		rtpCapabilities,
	})
	) {
		console.error('can not consume');
		return;
	}
	
	//consumer = await producerTransport.consume({ // NG: try use same trasport as producer (for loopback)
	consumer = await transport.consume(
	{ // OK
		producerId: producer.id,
		rtpCapabilities,
		paused: producer.kind === 'video',
	}).catch(err =>
	{
		console.error('consume failed', err);
		return;
	});
	
	consumer.on('producerclose', () => {
		// console.log('consumer -- on.producerclose');
		// try
		// {
		// 	let localId = getId(socket);
		// 	consumer.close ();
		// 	removeConsumer (localId, remoteId, kind);
		// }
		// catch(err)
		// {
		// 	console.log("code62, producer close ", err);
		// }
		//
		// // -- notify to client ---
		// socket.emit('producerClosed', { localId: localId, remoteId: remoteId, kind: kind });
	});
	consumer.on("transportclose", () =>
	{
		console.log("transport closed so consumer closed");
	});
	
	console.log("--------------------------------------------code48, consumer.type : ", consumer.type);
	//if (consumer.type === 'simulcast') {
	//  await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
	//}
	return {
		consumer: consumer,
		params: {
			producerId: producer.id,
			id: consumer.id,
			kind: consumer.kind,
			rtpParameters: consumer.rtpParameters,
			type: consumer.type,
			producerPaused: consumer.producerPaused
		}
	};
}
