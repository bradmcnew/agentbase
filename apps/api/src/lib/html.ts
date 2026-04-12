export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const HEAD = `<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <link href="/styles.css" rel="stylesheet">`

interface LayoutOptions {
  title: string
  userName: string
  activePage?: string
}

export function dashboardLayout(opts: LayoutOptions, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${HEAD}
  <title>${esc(opts.title)} — AgentBase</title>
</head>
<body style="min-height:100vh;display:flex">
  <aside class="sidebar">
    <div class="sidebar-logo"><a href="/dashboard" style="color:var(--fg)">AgentBase</a></div>
    <nav class="sidebar-nav">
      <a class="sidebar-link ${opts.activePage === 'agents' ? 'active' : ''}" href="/dashboard">Agents</a>
      <a class="sidebar-link ${opts.activePage === 'settings' ? 'active' : ''}" href="/dashboard/settings">Settings</a>
    </nav>
    <div class="sidebar-footer">
      ${esc(opts.userName)}<br>
      <a href="#" onclick="fetch('/api/auth/sign-out',{method:'POST',credentials:'include'}).then(()=>location.href='/login')" style="color:var(--muted)">Sign out</a>
    </div>
  </aside>
  <div class="main">
    ${content}
  </div>
</body>
</html>`
}

export function copyBox(url: string): string {
  return `<div class="copy-box" data-url="${esc(url)}" onclick="navigator.clipboard.writeText(this.dataset.url);this.querySelector('.copy-hint').textContent='Copied!';setTimeout(()=>this.querySelector('.copy-hint').textContent='Click to copy',2000)">
    <span>${esc(url)}</span>
    <span class="copy-hint">Click to copy</span>
  </div>`
}

export function authPage(title: string, content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${HEAD}
  <title>${esc(title)} — AgentBase</title>
</head>
<body style="min-height:100vh;display:flex;align-items:center;justify-content:center">
  <div class="auth-container">
    <div class="auth-logo"><a href="/" style="color:var(--fg)">AgentBase</a></div>
    ${content}
  </div>
</body>
</html>`
}
