// Shared tab bar for every logged-in portal page.
//
// Load after rmt-auth.js:
//   <script src="/js/rmt-auth.js"></script>
//   <script>RMTAuth.guard();</script>
//   <script src="/js/portal-nav.js" defer></script>
//
// It waits for RMTAuth.guard() to resolve, then puts a sticky bar (logo, tabs,
// user, sign out) at the top of <body>. Tabs are filtered by user: Max only
// gets Clients. The page's own <header> stays for its actions (Add Client,
// Refresh...), minus the logo / back links / sign-out the bar now covers.
(function () {
  'use strict';

  var ALL = ['Rob', 'Katy', 'Max'];
  var TEAM = ['Rob', 'Katy'];
  var TABS = [
    { label: 'Dashboard',      href: '/portal.html',         users: TEAM, match: ['/', '/portal.html', '/portal'] },
    { label: 'Clients',        href: '/clients.html',        users: ALL },
    { label: 'Command Center', href: '/command-center.html', users: ALL },  // Max: scoped to his client server-side
    { label: 'Subscriptions',  href: '/tracker.html',        users: TEAM },
    { label: 'VPS',            href: '/vps.html',            users: TEAM },
    { label: 'Demos',          href: '/demos.html',          users: TEAM },
    { label: 'Tax',            href: '/tax.html',            users: TEAM },
    { label: 'Ideas',          href: '/ideas.html',          users: TEAM },
    { label: 'Stripe',         href: 'https://dashboard.stripe.com', users: ['Rob'], external: true },
    { label: 'IurisIQ',        href: '#iurisiq',             users: ['Rob'], external: true, iurisiq: true },
    { label: 'Iurix',          href: 'https://iurixaccreditation.com/ops/metrics', users: ['Rob'], external: true },
  ];

  var CSS = '' +
    '.rmt-nav{position:sticky;top:0;z-index:1000;display:flex;align-items:center;gap:18px;' +
    'padding:10px 24px;background:#0d0f14;border-bottom:1px solid #1e2230;font-family:"Syne",sans-serif}' +
    '.rmt-brand img{display:block;height:34px;width:auto;background:#fff;padding:5px 12px;border-radius:9px}' +
    '.rmt-tabs{display:flex;gap:4px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}' +
    '.rmt-tabs::-webkit-scrollbar{display:none}' +
    '.rmt-tab{flex:none;padding:8px 13px;border-radius:8px;color:#8a90a0;text-decoration:none;' +
    'font-size:.82rem;font-weight:600;letter-spacing:.01em;white-space:nowrap;border:1px solid transparent;transition:color .15s,background .15s}' +
    '.rmt-tab:hover{color:#e8eaf0;background:#13161e}' +
    '.rmt-tab.active{color:#0d0f14;background:#4fffb0}' +
    '.rmt-tab.ext{color:#5a6070}.rmt-tab.ext:hover{color:#e8eaf0}' +
    '.rmt-sep{flex:none;width:1px;align-self:stretch;margin:6px 6px;background:#1e2230}' +
    '.rmt-user{flex:none;display:flex;align-items:center;gap:12px;font-family:"DM Mono",monospace;font-size:.72rem;color:#5a6070}' +
    '.rmt-out{background:none;border:1px solid #1e2230;color:#8a90a0;border-radius:6px;padding:6px 11px;' +
    'font-family:"DM Mono",monospace;font-size:.7rem;cursor:pointer}' +
    '.rmt-out:hover{color:#ff6b4a;border-color:#ff6b4a}' +
    // The bar replaces these parts of each page's own header.
    'body.has-rmt-nav header{position:static!important;padding-top:14px!important;padding-bottom:14px!important}' +
    'body.has-rmt-nav header .logo,body.has-rmt-nav header .back-link,' +
    'body.has-rmt-nav header a[href="/portal.html"],body.has-rmt-nav header .btn-logout,' +
    'body.has-rmt-nav header [onclick="logout()"]{display:none!important}' +
    '@media (max-width:720px){.rmt-nav{padding:8px 12px;gap:10px}.rmt-brand img{height:28px;padding:4px 9px}' +
    '.rmt-user .rmt-who{display:none}}' +
    '@media print{.rmt-nav{display:none}}';

  function isActive(tab) {
    var p = location.pathname.replace(/\/+$/, '') || '/';
    var list = tab.match || [tab.href];
    return list.indexOf(p) !== -1 || list.indexOf(p + '.html') !== -1;
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  function openIurisIQ(ev) {
    ev.preventDefault();
    // Open synchronously so popup blockers allow it, then point it at the
    // demo URL once the stats function tells us where it lives.
    var w = window.open('about:blank', '_blank');
    fetch('/.netlify/functions/iurisiq-stats')
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (m) {
        if (m && m.demo_url) { w.location.href = m.demo_url; }
        else { w.close(); alert('IurisIQ demo URL is not configured.'); }
      })
      .catch(function () { w.close(); });
  }

  function render(info) {
    var user = info && info.user;
    var style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var nav = el('nav', { class: 'rmt-nav', 'aria-label': 'Portal' });
    var brand = el('a', { class: 'rmt-brand', href: user === 'Max' ? '/clients.html' : '/portal.html' });
    brand.appendChild(el('img', { src: '/images/rmt-networks-logo.png', alt: 'RMT Networks' }));
    nav.appendChild(brand);

    var tabs = el('div', { class: 'rmt-tabs' });
    var sepAdded = false;
    TABS.forEach(function (t) {
      if (t.users.indexOf(user) === -1) return;
      if (t.external && !sepAdded) { tabs.appendChild(el('span', { class: 'rmt-sep' })); sepAdded = true; }
      var a = el('a', { class: 'rmt-tab' + (t.external ? ' ext' : '') + (isActive(t) ? ' active' : ''), href: t.href },
        t.label + (t.external ? ' ↗' : ''));
      if (t.external) { a.target = '_blank'; a.rel = 'noopener'; }
      if (t.iurisiq) a.addEventListener('click', openIurisIQ);
      if (isActive(t)) a.setAttribute('aria-current', 'page');
      tabs.appendChild(a);
    });
    nav.appendChild(tabs);

    var right = el('div', { class: 'rmt-user' });
    right.appendChild(el('span', { class: 'rmt-who' }, user || ''));
    var out = el('button', { class: 'rmt-out', type: 'button' }, 'Sign out');
    out.addEventListener('click', function () { RMTAuth.signOut(); });
    right.appendChild(out);
    nav.appendChild(right);

    document.body.classList.add('has-rmt-nav');
    document.body.insertBefore(nav, document.body.firstChild);

    // Hide a page header only if everything in it is something the bar
    // replaces. Empty-for-now elements (e.g. tax.html's usage meter, filled in
    // later) keep the header.
    var header = document.querySelector('body > header');
    if (header) {
      var keep = Array.prototype.some.call(header.querySelectorAll('*'), function (n) {
        return n.children.length === 0 && n.offsetParent !== null;
      });
      if (!keep) header.style.display = 'none';
    }

    var active = tabs.querySelector('.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function start() {
    if (!window.RMTAuth) return;
    RMTAuth.guard().then(render);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
