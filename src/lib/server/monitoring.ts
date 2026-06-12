const INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
	const mem = process.memoryUsage();
	const rss = Math.round(mem.rss / 1024 / 1024);
	const heap = Math.round(mem.heapUsed / 1024 / 1024);
	const total = Math.round(mem.heapTotal / 1024 / 1024);
	console.log(`[MEM] rss=${rss}MB heap=${heap}/${total}MB`);
}, INTERVAL_MS).unref();
