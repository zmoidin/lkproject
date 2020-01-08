const fs = require ('fs');
const youtubedl = require ('youtube-dl');

const VIDEO_DIR = process.env.VIDEO_DIR;

const ensureDir = () =>
{
	return fs.mkdir (`${VIDEO_DIR}`, function (err)
	{
		if (err && err.code === 'EEXIST')
		{
			return Promise.resolve ()
		} else
		{
			return Promise.resolve (err)
		}
	});
}

const getVideoInfo = async (video_url) =>
{
	// Optional arguments passed to youtube-dl.
	const options = ['--username=user', '--password=hunter2']
	
	return new Promise ((resolve, reject) =>
	{
		youtubedl.getInfo (video_url, options, function (err, info)
		{
			let videoObj = {};
			if (err)
			{
				reject (err);
			}
			
			videoObj.id = info.id;
			videoObj.title = info.title
			videoObj.video_url = info.video_url
			videoObj.thumbnail = info.thumbnail
			videoObj.description = info.description
			videoObj.filename = info._filename
			videoObj.formatid = info.format_id
			
			resolve (videoObj);
		});
	}).then ((videoObj) =>
	{
		console.log ('Video Object:', videoObj);
		return videoObj;
	})
}

const download_video = async (video_url) =>
{
	const video = youtubedl (video_url,
		// Optional arguments passed to youtube-dl.
		['--format=18'],
		// Additional options can be given for calling `child_process.execFile()`.
		{cwd: __dirname});
	
	const videoInfo = await getVideoInfo (video_url);
	// Check to see if we already have a video directory on the server, otherwise create it.
	return new Promise ((resolve, reject) =>
	{
		if (!fs.existsSync (`${VIDEO_DIR}`))
		{
			Promise.resolve ().then (() =>
			{
				ensureDir (`${VIDEO_DIR}`)
			}).then (() =>
			{
				resolve ()
			}).catch (error => reject (error))
		} else
		{
			// Just resolve it because the directory is already present
			resolve ();
		}
	}).then (() =>
	{
		return new Promise ((resolve, reject) =>
		{
			// Will be called when the download starts.
			video.on ('info', function (info)
			{
				console.log ('Download started')
				console.log ('filename: ' + info._filename)
				console.log ('size: ' + info.size)
			})
			
			video.pipe (fs.createWriteStream (`${VIDEO_DIR}/${videoInfo.id}.mp4`));
			
			video.on ('end', function ()
			{
				console.log ('finished downloading!');
				resolve ({msg: 'Downloaded successfully', statusCode: 200, video_id: `${videoInfo.id}`});
			})
			
		})
	}).catch ((err) =>
	{
		console.error (err);
		Promise.reject (err);
	})
}

module.exports = download_video;
