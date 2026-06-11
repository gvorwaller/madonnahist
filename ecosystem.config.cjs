// PM2 ecosystem config for madonnahist on the shared DigitalOcean droplet.
// Port 3002 (gaylonphotos=3000, giftlist=3001).
// See cs.md "Production Infrastructure" and docs/infrastructure-setup-plan.md.
//
// Reboot survival on the droplet (one-time, as root):
//   pm2 startup systemd -u root --hp /root
//   pm2 start ecosystem.config.cjs
//   pm2 save
//
// Secrets (PGPASSWORD, MIGRATION_PGPASSWORD, AUTH_SECRET, etc.) live in
// /opt/madonnahist/.env, mode 600, owned root:root. Loaded into process.env
// at boot via Node's built-in --env-file flag (Node ≥ 20.6). This means
// `process.env.PGPASSWORD` etc. resolve before any SvelteKit module reads
// them via $env/dynamic/private.

module.exports = {
	apps: [
		{
			name: 'madonnahist',
			script: 'build/index.js',
			node_args: '--env-file=.env',
			cwd: '/opt/madonnahist',

			instances: 1,
			exec_mode: 'fork',

			autorestart: true,
			restart_delay: 5000,
			max_restarts: 10,
			min_uptime: '30s',
			max_memory_restart: '2500M',

			// Capture stdout/stderr in PM2's rotated logs.
			out_file: '/var/log/pm2/madonnahist.out.log',
			error_file: '/var/log/pm2/madonnahist.err.log',
			merge_logs: true,
			time: true,

			env: {
				NODE_ENV: 'production',
				HOST: '127.0.0.1',
				PORT: 3002
			}
		}
	]
};
