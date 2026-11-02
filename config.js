const localHosts = new Set(['localhost', '127.0.0.1']);
const isLocalHttp = location.protocol === 'http:' && localHosts.has(location.hostname);
window.ZACORD_API_URL = isLocalHttp
	? `http://${location.hostname}:3000`
	: 'https://zacord.onrender.com';
