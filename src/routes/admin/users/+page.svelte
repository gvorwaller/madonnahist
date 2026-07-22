<script lang="ts">
	import { enhance } from '$app/forms';

	const { data } = $props();

	const roleLabels: Record<string, string> = {
		admin: 'Admin',
		corrector: 'Corrector',
		viewer: 'Viewer'
	};

	let addingUser = $state(false);
	let addUsername = $state('');
	let addDisplayName = $state('');
	let addRole = $state('viewer');
	let addPassword = $state('');
	let actionError = $state('');

	let resetTarget = $state<{ id: number; username: string } | null>(null);
	let resetPassword = $state('');

	function startAddUser() {
		addingUser = true;
		addUsername = '';
		addDisplayName = '';
		addRole = 'viewer';
		addPassword = '';
	}

	function cancelAddUser() {
		addingUser = false;
	}

	function startReset(u: { id: number; username: string }) {
		resetTarget = { id: u.id, username: u.username };
		resetPassword = '';
	}

	function cancelReset() {
		resetTarget = null;
		resetPassword = '';
	}

	function formatLastLogin(v: string | null) {
		return v ?? 'Never';
	}
</script>

<svelte:window onkeydown={(e) => {
	if (e.key === 'Escape') {
		if (resetTarget) cancelReset();
		if (addingUser) cancelAddUser();
	}
}} />

<div class="page">
	<header>
		<h1>User Accounts</h1>
		<p class="subtitle">Create family accounts and reset passwords. No self-registration — every account is admin-created.</p>
	</header>

	{#if actionError}
		<div class="error-banner" role="alert">
			{actionError}
			<button class="error-dismiss" onclick={() => actionError = ''}>Dismiss</button>
		</div>
	{/if}

	<section class="section">
		<table class="data-table">
			<thead>
				<tr>
					<th>Username</th>
					<th>Display Name</th>
					<th>Role</th>
					<th>Created</th>
					<th>Last Login</th>
					<th class="col-actions">Actions</th>
				</tr>
			</thead>
			<tbody>
				{#each data.users as u (u.id)}
					<tr>
						<td class="token">{u.username}</td>
						<td>{u.display_name}</td>
						<td><span class="role-badge role-{u.role}">{roleLabels[u.role] ?? u.role}</span></td>
						<td class="date-cell">{u.created_at}</td>
						<td class="date-cell">{formatLastLogin(u.last_login_at)}</td>
						<td class="col-actions">
							<button class="btn btn-sm btn-secondary" onclick={() => startReset(u)}>Reset password</button>
						</td>
					</tr>
				{/each}
				{#if addingUser}
					<tr>
						<td colspan="6">
							<form method="POST" action="?/create" use:enhance={() => {
								return ({ result, update }) => {
									if (result.type === 'failure') {
										actionError = (result.data as { error?: string })?.error ?? 'Create failed';
									} else {
										cancelAddUser();
										update();
									}
								};
							}}>
								<div class="edit-row">
									<input type="text" name="username" bind:value={addUsername} class="input" placeholder="Username" autocomplete="off" />
									<input type="text" name="displayName" bind:value={addDisplayName} class="input" placeholder="Display name" />
									<select name="role" bind:value={addRole} class="input">
										{#each Object.entries(roleLabels) as [value, label]}
											<option {value}>{label}</option>
										{/each}
									</select>
									<input type="password" name="password" bind:value={addPassword} class="input" placeholder="Password" autocomplete="new-password" />
									<button type="submit" class="btn btn-sm btn-primary"
										disabled={addUsername.trim() === '' || addDisplayName.trim() === '' || addPassword.length < 8}>
										Create
									</button>
									<button type="button" class="btn btn-sm btn-secondary" onclick={cancelAddUser}>Cancel</button>
								</div>
								<p class="hint">Password must be at least 8 characters.</p>
							</form>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="6">
							<button class="btn btn-sm btn-secondary add-btn" onclick={startAddUser}>+ Add user</button>
						</td>
					</tr>
				{/if}
			</tbody>
		</table>
	</section>
</div>

<!-- Reset password confirmation modal -->
{#if resetTarget}
	<div class="modal-overlay" role="dialog" aria-label="Reset password">
		<div class="modal">
			<h2>Reset Password</h2>
			<p>
				Set a new password for <strong>{resetTarget.username}</strong>.
				This immediately signs them out of every device — they must log in again with the new password.
			</p>
			<form method="POST" action="?/resetPassword" use:enhance={() => {
				return ({ result, update }) => {
					if (result.type === 'failure') {
						actionError = (result.data as { error?: string })?.error ?? 'Reset failed';
						resetTarget = null;
					} else {
						resetTarget = null;
						update();
					}
				};
			}}>
				<input type="hidden" name="userId" value={resetTarget.id} />
				<div class="form-group">
					<label for="reset-password">New password</label>
					<input id="reset-password" type="password" name="newPassword" bind:value={resetPassword} class="input" autocomplete="new-password" />
				</div>
				<div class="modal-actions">
					<button type="button" class="btn btn-secondary" onclick={cancelReset}>Cancel</button>
					<button type="submit" class="btn btn-danger" disabled={resetPassword.length < 8}>Reset password</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		padding: 1rem;
	}
	header {
		margin-bottom: 1.5rem;
	}
	h1 {
		margin: 0;
		font-size: 1.4rem;
	}
	.subtitle {
		color: #444;
		font-size: 0.85rem;
		margin: 0.3rem 0 0;
	}

	.section {
		margin-bottom: 2rem;
	}

	.data-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}
	.data-table th {
		text-align: left;
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid #999;
		font-weight: 600;
		color: #222;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.data-table td {
		padding: 0.35rem 0.5rem;
		border-bottom: 1px solid #e0e0e0;
		vertical-align: middle;
		color: #1a1a1a;
	}
	.col-actions {
		width: 160px;
		text-align: right;
		white-space: nowrap;
	}
	.date-cell {
		font-size: 0.8rem;
		color: #444;
	}
	.token {
		font-family: monospace;
		font-size: 0.85rem;
	}
	.hint {
		margin: 0.3rem 0 0;
		font-size: 0.75rem;
		color: #444;
	}

	/* Role badges: color is decorative only — the text label is always
	   present, per the "color + text, never color alone" rule. */
	.role-badge {
		display: inline-block;
		font-size: 0.72rem;
		font-weight: 600;
		border-radius: 3px;
		padding: 0.1rem 0.45rem;
		border: 1px solid;
	}
	.role-admin {
		color: #7a1a1a;
		background: #fbe9e9;
		border-color: #7a1a1a;
	}
	.role-corrector {
		color: #14315c;
		background: #e8eef8;
		border-color: #14315c;
	}
	.role-viewer {
		color: #14431a;
		background: #e8f5e9;
		border-color: #14431a;
	}

	.btn {
		border: none;
		border-radius: 4px;
		padding: 0.4rem 0.8rem;
		font-size: 0.85rem;
		font-weight: 600;
		cursor: pointer;
	}
	.btn-sm {
		padding: 0.2rem 0.5rem;
		font-size: 0.75rem;
	}
	.btn-primary {
		background: #1a7a1a;
		color: #fff;
	}
	.btn-secondary {
		background: #fff;
		color: #1a1a1a;
		border: 1px solid #999;
	}
	.btn-danger {
		background: #fff;
		color: #a02020;
		border: 1px solid #a02020;
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.add-btn {
		margin: 0.25rem 0;
	}

	.edit-row {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.25rem 0;
		flex-wrap: wrap;
	}
	.input {
		padding: 0.3rem 0.5rem;
		border: 1px solid #999;
		border-radius: 4px;
		font-size: 0.85rem;
		font-family: inherit;
	}

	.form-group {
		margin: 1rem 0;
	}
	.form-group label {
		display: block;
		font-size: 0.8rem;
		font-weight: 600;
		margin-bottom: 0.3rem;
		color: #333;
	}
	.form-group .input {
		width: 100%;
		box-sizing: border-box;
	}

	.error-banner {
		padding: 0.6rem 1rem;
		background: #fde2e2;
		border: 1px solid #a02020;
		border-radius: 4px;
		color: #7a1414;
		font-size: 0.85rem;
		font-weight: 600;
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}
	.error-dismiss {
		background: none;
		border: none;
		color: #7a1414;
		cursor: pointer;
		font-size: 0.8rem;
		text-decoration: underline;
	}

	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.modal {
		background: #fff;
		border-radius: 8px;
		padding: 1.5rem;
		max-width: 420px;
		width: 90%;
	}
	.modal h2 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}
	.modal p {
		margin: 0 0 1rem;
		color: #333;
		font-size: 0.9rem;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.modal-actions .btn {
		min-height: 40px;
		min-width: 80px;
	}
</style>
