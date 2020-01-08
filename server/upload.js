require ('dotenv').config ();
const https = require ("https"), http = require ("http");
var formidable = require('formidable');
var fs = require('fs');
let port = (process.env.port || 3000);
if (process.env.mode == 'developement')
{
	var server = http.createServer (runUpload).listen(port);
}
else
{
	console.log ('in production');
	var options =
	{
		key: fs.readFileSync ("ssl/server.key"),
		cert: fs.readFileSync ("ssl/server.crt")
	};
	var server = https.createServer (options, runUpload).listen(port);
}
//http.createServer(runUpload).listen(8080);

function runUpload(req, res)
{
	if (req.url == '/fileupload')
	{
		var form = new formidable.IncomingForm();
		form.parse(req, function (err, fields, files)
		{
			var oldpath = files.filetoupload.path;
			var newpath = 'uploads/' + files.filetoupload.name;
			fs.rename(oldpath, newpath, function (err) {
				if (err) throw err;
				res.write('File uploaded and moved!');
				res.end();
			});
		});
	} else {
		res.writeHead(200, {'Content-Type': 'text/html'});
		res.write('No data submitted');
		return res.end();
	}
}
