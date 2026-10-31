// Sessions can now be revoked server-side (password change, "sign out everywhere",
// an admin deleting or demoting the account), so a 401 mid-session is a real
// possibility rather than an impossible state. Bounce to the login page once
// instead of letting every poller spray "Unauthorized" toasts forever.
let signingOut=false;
function forceSignOut(msg){
  if(signingOut) return; signingOut=true;
  try{localStorage.removeItem('bs_token');}catch(e){}
  location.href='/login.html'+(msg?('?msg='+encodeURIComponent(msg)):'');
}
const API = async (u,o={})=>{const token=localStorage.getItem('bs_token');const h=Object.assign({},o.headers||{},token?{Authorization:'Bearer '+token}:{});const r=await fetch(u,Object.assign({},o,{headers:h}));const d=await r.json().catch(()=>({}));if(r.status===401){forceSignOut(d.error||'Your session ended — please sign in again.');throw new Error(d.error||'Unauthorized')}if(!r.ok) throw new Error(d.error||'Request failed');return d};
const $=s=>document.querySelector(s), $$=s=>Array.from(document.querySelectorAll(s));
const esc=s=>String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
// Ask the server whether a search result is already in your library — Chaptarr for
// eBooks and authors, Listenarr for audiobooks.
// Returns {inLibrary, where, label, matchedTitle}; never throws (search must not break).
async function libraryCheck(kind,item){
  const title=kind==='author'?(item.name||item.title||''):(item.title||item.name||'');
  const author=item.author||(kind==='author'?(item.name||''):'');
  const asin=kind==='audio'?(item.asin||item.key||''):'';
  const qs='kind='+encodeURIComponent(kind)+'&title='+encodeURIComponent(title)+'&author='+encodeURIComponent(author)+'&asin='+encodeURIComponent(asin);
  try{return await API('/api/library/check?'+qs);}catch(e){return {inLibrary:false,where:null};}
}
let me=null,current=null;
let reqKind='book',reqResults=[],lastPollMaxId=null,reqMax=0,notifBooted=false,lastSeenPushed=0;
// Request ids with an approve/reject in flight. The 20s poller re-renders the whole
// table, which would otherwise resurrect a fresh "Approve" button over a send that is
// still running and invite a duplicate click.
const inFlightRequests=new Set();
// Two downloaders, two sets of settings. Chaptarr (eBooks/authors) wants a quality
// profile, a metadata profile and a root folder; Listenarr (audiobooks) only wants a
// quality profile. The request modal shows whichever set matches what's being asked for.
let opts={chaptarr:{qualityProfiles:[],metadataProfiles:[],rootFolders:[]},listenarr:{qualityProfiles:[],rootFolders:[]}};

/* ─ Toast ─────────────────────────────────────────────────── */
function toast(msg,type='ok'){const t=document.createElement('div');t.className='toast '+type;t.textContent=msg;$('#toast').appendChild(t);setTimeout(()=>t.remove(),3200)}

/* ─ Notifications (server-side, synced across every browser/phone) ─
   The unseen count lives on the SERVER (per admin user in db.json), not in
   localStorage — so checking All Requests on your phone clears the badge on
   your desktop too, and vice versa, within one poll interval. */
function viewingAllRequests(){const el=$('#page-all-requests');return !!(el&&el.classList.contains('active'));}
function updateReqBadge(n){
  ['req-badge','req-badge-m'].forEach(id=>{
    const b=document.getElementById(id); if(!b) return;
    if(n>0){b.textContent=n>9?'9+':String(n);b.classList.remove('hidden');}
    else{b.classList.add('hidden');b.textContent='';}
  });
}
async function loadNotifications(){
  if(!me||me.role!=='admin') return;
  try{
    const d=await API('/api/notifications');
    // Pending requests are ACTIONABLE (need an approve/reject), so they keep the
    // badge lit even after they've been "seen". Otherwise show the unseen count —
    // unless this tab is already looking at All Requests.
    const pending=d.pending||0;
    const unseen=viewingAllRequests()?0:(d.unseen||0);
    updateReqBadge(Math.max(pending,unseen));
    if(!notifBooted){
      notifBooted=true;
      if(pending>0) toast(pending+' request'+(pending>1?'s':'')+' waiting for your approval','info');
      else if(d.unseen>0) toast(d.unseen+' new request'+(d.unseen>1?'s':'')+' since your last check','info');
    }
  }catch(e){/* badge is best-effort */}
}
async function markRequestsSeen(){
  updateReqBadge(0);                       // clear locally right away…
  if(!me||me.role!=='admin') return;
  try{await API('/api/notifications/seen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});}
  catch(e){/* …the server marker will catch up on the next visit */}
}

/* ─ Pages ─────────────────────────────────────────────────── */
function showPage(p){$$('.page').forEach(x=>x.classList.remove('active'));$('#page-'+p).classList.add('active');$$('.nav').forEach(n=>n.classList.toggle('active',n.dataset.page===p));if(p==='all-requests')markRequestsSeen();}
function openModal(id){$('#'+id).classList.remove('hidden')}
function closeModal(id){$('#'+id).classList.add('hidden')}

/* ─ Fallback cover image ──────────────────────────────────── */
// Truncate BEFORE escaping. Slicing the escaped string could cut an entity in half
// ("&#39;" → "&#"), producing invalid XML that the browser refuses to render — so a
// title with an apostrophe or ampersand near the cut got no placeholder cover at all.
function fallback(t){return 'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="100%" height="100%" fill="#1e2132"/><text x="50%" y="50%" fill="#a78bfa" font-family="Inter,Arial" font-size="22" text-anchor="middle" dominant-baseline="middle">${esc(String(t||'').slice(0,22))}</text></svg>`)}

/* CSP-safe replacement for inline onerror: swap broken covers for the fallback */
document.addEventListener('error',e=>{
  const img=e.target;
  if(img&&img.tagName==='IMG'&&!img.dataset.fbk){img.dataset.fbk='1';img.src=fallback(img.alt||'');}
},true);

/* ─ Card renderer ─────────────────────────────────────────── */
function card(item,type){
  const isAuthor=type==='author', isAudio=type==='audio';
  const title=isAuthor?item.name:item.title;
  const chipCls=isAuthor?'chip author':isAudio?'chip audio':'chip';
  const chipTxt=isAuthor?'Author':isAudio?'Audiobook':'eBook';
  const img=item.image||fallback(title);
  const desc=item.description||'';
  const sub=isAuthor?'Author':isAudio?(item.narrator?('Narr. '+item.narrator):'Audiobook'):'eBook';
  // "Because you have …" on recommendations: in the card body, not the hover overlay,
  // because touch screens never show the overlay.
  const why=item.why?`<div class="why" title="${esc(item.why)}">${esc(item.why)}</div>`:'';
  return `<article class="tile" data-kind="${isAuthor?'author':isAudio?'audio':'book'}" data-payload='${esc(JSON.stringify(item))}'><div class="imgwrap"><img src="${esc(img)}" alt="${esc(title)}"><div class="overlay"><div class="overlay-top"><span class="${chipCls}">${chipTxt}</span><span class="meta">${esc(item.source||'Google Books')}</span></div><div class="ov-title">${esc(title)}</div><div class="ov-sub">${esc(desc)}</div><div class="ov-actions"><button class="btn btn-primary btn-sm">Request</button></div></div><span class="badge">${esc(item.year||'')}</span></div><div class="body"><div class="title">${esc(title)}</div><div class="sub">${esc(sub)}</div>${why}</div></article>`
}

/* ─ Connection status widgets ─────────────────────────────── */
async function checkStatus(endpoint, pillId, nameId, verId, fallbackName, reflectDot){
  const pill=$('#'+pillId), name=$('#'+nameId), ver=$('#'+verId);
  if(!pill||!name||!ver) return;   // widget not on the page — don't take the boot down with it
  const dot=$('.topbar .status-dot');
  const setDot=(cls,title)=>{if(reflectDot&&dot){dot.className='status-dot'+(cls?' '+cls:'');dot.title=title||'';}};
  pill.className='conn-pill checking'; name.textContent='Connecting…'; ver.textContent=''; ver.className='conn-version'; setDot('wait','Checking…');
  try{
    const s=await API(endpoint);
    if(s.connected){
      pill.className='conn-pill connected';
      name.textContent=s.appName||fallbackName;
      ver.className='conn-version'; ver.textContent=s.version?('v'+s.version):'Connected';
      setDot('',fallbackName+' connected'+(s.version?' v'+s.version:''));
    } else {
      pill.className='conn-pill disconnected';
      name.textContent='Not connected';
      ver.className='conn-err'; ver.textContent=s.error||('Cannot reach '+fallbackName);
      setDot('bad',fallbackName+' not connected');
    }
  }catch(e){
    pill.className='conn-pill disconnected';
    name.textContent='Not connected';
    ver.className='conn-err'; ver.textContent=e.message||'Connection failed';
    setDot('bad',fallbackName+' not connected');
  }
}
const checkChaptarrStatus=()=>checkStatus('/api/chaptarr/status','conn-pill','conn-name','conn-version','Chaptarr',true);
const checkListenarrStatus=()=>checkStatus('/api/listenarr/status','conn2-pill','conn2-name','conn2-version','Listenarr',false);
const checkAllStatus=()=>{checkChaptarrStatus();checkListenarrStatus();};

/* ─ Load current user ─────────────────────────────────────── */
async function loadMe(){
  me=await API('/api/me');
  $('#whoami').textContent=me.username;
  $('#user-meta').textContent=`${me.role} · ${me.requests}/${me.limit} requests today`;
  $$('.admin-only').forEach(e=>e.classList.toggle('hidden',me.role!=='admin'));
}

/* ─ Load profile/folder options for both targets ──────────── */
async function loadOptions(){
  // allSettled-style: one unconfigured downloader must not blank out the other's
  // profiles, or the request modal for the service that IS working goes empty.
  const [ch,la]=await Promise.all([
    API('/api/chaptarr/options').catch(()=>({qualityProfiles:[],metadataProfiles:[],rootFolders:[]})),
    API('/api/listenarr/options').catch(()=>({qualityProfiles:[],rootFolders:[]}))
  ]);
  opts.chaptarr={qualityProfiles:ch.qualityProfiles||[],metadataProfiles:ch.metadataProfiles||[],rootFolders:ch.rootFolders||[]};
  opts.listenarr={qualityProfiles:la.qualityProfiles||[],rootFolders:la.rootFolders||[]};
}

/* ─ Discover ─────────────────────────────────────────────── */
// Render one Discover row, then flag any items already in the library — reusing the
// same annotateLibrary() path the search page uses, so badges look/behave identically.
// A row with nothing in it is hidden (heading and all) rather than left as an empty
// box saying "No eBooks found" — an upstream being down is not something to display.
function renderRow(sel,items,cardType){
  const el=$(sel);
  if(!el) return;
  const list=items||[];
  const wrap=el.closest('.slider-wrap'), head=wrap&&wrap.previousElementSibling;
  [wrap,head&&head.classList.contains('section-head')?head:null].forEach(x=>x&&x.classList.toggle('hidden',!list.length));
  el.innerHTML=list.map((it,i)=>card(it,cardType).replace('<article class="tile"','<article class="tile" data-libidx="'+i+'"')).join('');
  annotateLibrary(el,list,cardType);
}
async function loadDiscover(){
  const d=await API('/api/discover').catch(()=>({authors:[],ebooks:[],topEbooks:[],audioRecent:[],audioUpcoming:[],topAudio:[]}));
  renderRow('#authors-track',(d.authors||[]).slice(0,20),'author');
  renderRow('#ebooks-track',(d.ebooks||[]).slice(0,40),'book');
  renderRow('#top-ebooks-track',d.topEbooks||[],'book');
  renderRow('#audio-recent-track',d.audioRecent||[],'audio');
  renderRow('#audio-upcoming-track',d.audioUpcoming||[],'audio');
  renderRow('#top-audio-track',d.topAudio||[],'audio');
}
// The rows built from the library. Loaded on their own so the generic rows below
// don't wait on them (a cold build takes a few seconds; after that it's cached).
async function loadForYou(){
  const host=$('#for-you-rows');
  if(!host) return;
  host.innerHTML='<div class="small for-you-loading">Picking books from what\'s already in your library…</div>';
  const d=await API('/api/discover/for-you').catch(()=>({rows:[]}));
  const rows=(d.rows||[]).filter(r=>r&&Array.isArray(r.items)&&r.items.length);
  if(!rows.length){host.innerHTML=d.note?'<div class="small for-you-loading">'+esc(d.note)+'</div>':'';return;}
  host.innerHTML=rows.map((r,i)=>`<div class="section-head"><div class="section-title"><h2>${esc(r.title)}</h2>${r.subtitle?`<p class="section-sub">${esc(r.subtitle)}</p>`:''}</div><div class="slider-controls"><button class="slider-btn" data-target="fy-track-${i}" data-dir="-1">&#8249;</button><button class="slider-btn" data-target="fy-track-${i}" data-dir="1">&#8250;</button></div></div><div class="slider-wrap"><div class="slider-track" id="fy-track-${i}"></div></div>`).join('');
  rows.forEach((r,i)=>renderRow('#fy-track-'+i,r.items,r.kind));
}

/* ─ Requests table ───────────────────────────────────────── */
let reqFilter='all';   // All Requests status chip: all | pending | sent | rejected | error
// One place changes the filter, so the chips, the counter cards, and the table
// always agree — cards and chips are both clickable.
function setReqFilter(status){
  reqFilter=status||'all';
  $$('#req-filter .fbtn').forEach(x=>x.classList.toggle('active',(x.dataset.status||'all')===reqFilter));
  $$('#req-stats .stat-card').forEach(x=>x.classList.toggle('active',(x.dataset.status||'all')===reqFilter));
  loadRequests();
}
async function loadRequests(){
  const rs=await API('/api/requests').catch(()=>[]);
  // Inline SVG icons (stroke=currentColor) instead of emoji — they render
  // identically on every browser/phone and can never fall back to a tofu box.
  const ICON={
    book:'<svg class="kicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    audio:'<svg class="kicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
    author:'<svg class="kicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
  };
  const kindLabel=k=>k==='audio'?ICON.audio+' Audiobook':k==='author'?ICON.author+' Author':ICON.book+' eBook';
  const statusBadge=r=>r.status==='sent'?'<span class="status-sent">● Sent</span>'
    :r.status==='pending'?'<span class="status-pend">● Pending</span>'
    :r.status==='rejected'?'<span class="status-err">● Rejected</span>'
    :'<span class="status-err">● '+esc(r.status)+'</span>';
  // Where the request went. Older eBook rows carry the pre-rename 'bookshelf'
  // destination; that is the same service as Chaptarr, so show the current name.
  const dest=r=>(r.destination==='listenarr'||(!r.destination&&r.kind==='audio'))?'Listenarr':'Chaptarr';
  const adminCols=me.role==='admin'?'<th>User</th>':'';
  const adminTd=r=>me.role==='admin'?`<td>${esc(r.username||'')}</td>`:'';
  const authorCell=r=>{
    const a=esc(r.author||'');
    // eBooks go to Chaptarr as a whole-author add; show which author it went under.
    if(r.kind!=='audio'&&r.kind!=='author'&&r.sentAsAuthor&&norm(r.sentAsAuthor)!==norm(r.author||''))
      return `${a}<div class="small muted">sent as author: ${esc(r.sentAsAuthor)}</div>`;
    return a;
  };
  // Action buttons: admins can Approve/Reject pending requests (Approve = send to
  // the downloader NOW) and Retry errored ones (same endpoint). Users can cancel
  // their own pending requests — deleting a pending row refunds the daily slot.
  const actions=r=>{
    // A send is running for this row — show that, and offer nothing to click.
    if(inFlightRequests.has(String(r.id))) return '<button class="btn btn-ghost btn-sm" disabled>Sending…</button>';
    const del=`<button class="btn btn-danger btn-sm" data-delreq="${r.id}">${r.status==='pending'&&me.role!=='admin'?'Cancel':'Delete'}</button>`;
    if(me.role!=='admin') return del;
    if(r.status==='pending') return `<button class="btn btn-primary btn-sm" data-approve="${r.id}">Approve</button><button class="btn btn-ghost btn-sm" data-reject="${r.id}">Reject</button>${del}`;
    if(r.status==='error') return `<button class="btn btn-ghost btn-sm" data-approve="${r.id}" title="Send this request to the downloader again">Retry</button>${del}`;
    return del;
  };
  const row=r=>`<tr><td>${kindLabel(r.kind)}</td><td><strong>${esc(r.title||r.author)}</strong></td><td>${authorCell(r)}</td>${adminTd(r)}<td>${esc(dest(r))}</td><td>${statusBadge(r)}</td><td class="small">${esc(r.message||'')}</td><td style="display:flex;gap:6px;flex-wrap:wrap">${actions(r)}</td></tr>`;
  const cols=me.role==='admin'?8:7;
  const buildTable=(list,empty)=>`<table><thead><tr><th>Type</th><th>Title</th><th>Author</th>${adminCols}<th>Sent To</th><th>Status</th><th>Note</th><th></th></tr></thead><tbody>${list.map(row).join('')||`<tr><td colspan="${cols}" class="small" style="padding:20px;text-align:center">${empty}</td></tr>`}</tbody></table>`;
  $('#my-requests').innerHTML=buildTable(rs,'No requests yet');
  if(me.role==='admin'){
    const filtered=reqFilter==='all'?rs:rs.filter(r=>r.status===reqFilter);
    $('#all-requests').innerHTML=buildTable(filtered,reqFilter==='all'?'No requests yet':'No '+esc(reqFilter)+' requests');
    // Counter cards — always computed from the FULL list, never the filtered view.
    const cnt=st=>rs.filter(r=>r.status===st).length;
    const setNum=(id,v)=>{const el=$('#'+id);if(el)el.textContent=String(v);};
    setNum('st-total',rs.length);
    setNum('st-sent',cnt('sent'));
    setNum('st-pending',cnt('pending'));
    setNum('st-rejected',cnt('rejected'));
    setNum('st-error',cnt('error'));
    // Pending count on the filter chip (always from the FULL list, not the filter).
    const pend=cnt('pending');
    const fc=$('#fc-pending'); if(fc){fc.textContent=pend>9?'9+':String(pend);fc.classList.toggle('hidden',!pend);}
  }

  // Live toasts for admins while a tab is open. The unseen COUNT (nav badge)
  // comes from the server via loadNotifications(), so it stays consistent across
  // every browser and phone — checking on one device clears it everywhere.
  if(me.role==='admin'){
    reqMax=rs.reduce((m,r)=>Math.max(m,r.id||0),0);
    if(lastPollMaxId!==null){
      const fresh=rs.filter(r=>r.id>lastPollMaxId && r.username!==me.username);
      fresh.slice(-3).forEach(r=>toast(
        r.status==='pending'
          ?'Approval needed: '+(r.title||r.author||'(untitled)')+' — '+(r.username||'user')
          :'New request: '+(r.title||r.author||'(untitled)')+' — '+(r.username||'user'),
        'info'));
    }
    lastPollMaxId=reqMax;
    // If this admin is LOOKING at All Requests right now, whatever just arrived is
    // instantly seen — push the marker so other devices clear their badges too.
    // Only when it actually MOVED: a parked tab re-posted this every 20s forever,
    // and each post is a full read-modify-write of db.json (~4,300 pointless fsync'd
    // rewrites a day, per open tab).
    if(viewingAllRequests()&&reqMax>0&&reqMax>lastSeenPushed){
      lastSeenPushed=reqMax;
      API('/api/notifications/seen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lastSeenRequestId:reqMax})}).catch(()=>{lastSeenPushed=0;});
    }
  }
}

/* ─ Users table ──────────────────────────────────────────── */
async function loadUsers(){
  if(me.role!=='admin') return;
  const users=await API('/api/users');
  const aa=u=>u.role==='admin'?'<span class="status-sent">Always (admin)</span>'
    :u.autoApprove==='on'?'<span class="status-sent">Always</span>'
    :u.autoApprove==='off'?'<span class="status-pend">Needs approval</span>'
    :'<span class="muted">Global default</span>';
  // Relative "last seen" so an admin can tell at a glance who actually uses the app.
  const ago=d=>{
    if(!d) return '<span class="muted">never</span>';
    const s=Math.max(0,(Date.now()-new Date(d).getTime())/1000);
    if(s<90) return 'just now';
    const m=s/60; if(m<60) return Math.round(m)+'m ago';
    const h=m/60; if(h<24) return Math.round(h)+'h ago';
    const dd=h/24; if(dd<30) return Math.round(dd)+'d ago';
    return new Date(d).toLocaleDateString();
  };
  const rows=users.map(u=>`<tr><td><strong>${esc(u.username)}</strong>${u.locked?' <span class="status-err" title="Temporarily locked after repeated failed sign-ins">🔒 locked</span>':''}</td><td>${u.role==='admin'?'<span style="color:var(--purple-lt);font-weight:700">Admin</span>':'<span class="muted">User</span>'}</td><td>${u.requests}</td><td>${u.limit}</td><td>${u.canRequest?'<span class="status-sent">Yes</span>':'<span class="status-err">No</span>'}</td><td>${aa(u)}</td><td class="small">${ago(u.lastLoginAt)}</td><td style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" data-edituser="${u.id}">Edit</button><button class="btn btn-danger btn-sm" data-deluser="${u.id}">Delete</button></td></tr>`).join('');
  $('#users-table').innerHTML=`<table><thead><tr><th>Username</th><th>Role</th><th>Requests</th><th>Limit</th><th>Can Request</th><th>Auto-approve</th><th>Last Seen</th><th>Actions</th></tr></thead><tbody>${rows||'<tr><td colspan="8" class="small" style="padding:20px;text-align:center">No users</td></tr>'}</tbody></table>`;
}

/* ─ API keys table (admin) ───────────────────────────────── */
async function loadApiKeys(){
  if(me.role!=='admin') return;
  const keys=await API('/api/apikeys').catch(()=>[]);
  const fmt=d=>d?new Date(d).toLocaleString():'—';
  const rows=keys.map(k=>`<tr><td><strong>${esc(k.name)}</strong></td><td><code class="apikey">${esc(k.key)}</code></td><td class="small">${esc(fmt(k.createdAt))}</td><td class="small">${esc(fmt(k.lastUsedAt))}</td><td style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" data-copykey="${esc(k.key)}">Copy</button><button class="btn btn-danger btn-sm" data-delkey="${k.id}">Revoke</button></td></tr>`).join('');
  $('#apikeys-table').innerHTML=`<table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last Used</th><th>Actions</th></tr></thead><tbody>${rows||'<tr><td colspan="5" class="small" style="padding:20px;text-align:center">No API keys yet — generate one to let another program connect.</td></tr>'}</tbody></table>`;
}

/* ─ Integration settings (admin) — link Chaptarr in-app ─
   Values are saved server-side (db.json), so they apply to every browser and
   phone immediately and override the .env file. Upstream API keys are write-only:
   the server only ever returns a masked tail, never the full key. */
function setSourcePill(id,src){
  const el=$('#'+id); if(!el) return;
  el.textContent=src==='app'?'Saved in app':src==='env'?'From .env':'Not configured';
  el.className='src-pill'+(src==='app'?' app':src==='env'?' env':'');
}
async function loadSettings(){
  if(!me||me.role!=='admin') return;
  try{
    const s=await API('/api/admin/settings/integrations');
    $('#set-b-url').value=s.chaptarr.url||'';
    $('#set-b-key').value='';
    $('#set-b-key').placeholder=s.chaptarr.apiKeySet?('Saved · '+s.chaptarr.apiKeyMasked+' — leave blank to keep'):'Paste the Chaptarr API key';
    setSourcePill('set-b-source',s.chaptarr.source);
    const l=s.listenarr||{};
    $('#set-l-url').value=l.url||'';
    $('#set-l-key').value='';
    $('#set-l-key').placeholder=l.apiKeySet?('Saved · '+l.apiKeyMasked+' — leave blank to keep'):'Paste the Listenarr API key';
    setSourcePill('set-l-source',l.source);
  }catch(e){/* settings page is admin-only; ignore for everyone else */}
  // ── Requests & Approvals: the global auto-approve toggle ──
  try{
    const a=await API('/api/admin/settings/approvals');
    const on=a.autoApproveAll!==false;
    const cb=$('#set-approve-all'); if(cb) cb.checked=on;
    const pill=$('#set-a-state');
    if(pill){pill.textContent=on?'Auto-approve ON':'Approval required';pill.className='src-pill'+(on?' app':' env');}
  }catch(e){/* admin-only */}
  // ── Notifications: webhook target + which events to send ──
  try{
    const n=await API('/api/admin/settings/notifications');
    const cb=$('#set-n-enabled'); if(cb) cb.checked=!!n.enabled;
    const url=$('#set-n-url');
    if(url){url.value='';url.placeholder=n.urlSet?('Saved · '+n.urlMasked+' — leave blank to keep'):'https://discord.com/api/webhooks/…';}
    ['submitted','approved','rejected','error'].forEach(e=>{
      const b=$('#set-n-ev-'+e); if(b) b.checked=(n.events||{})[e]!==false;
    });
    const pill=$('#set-n-state');
    if(pill){
      const on=n.enabled&&n.urlSet;
      pill.textContent=on?'Notifications ON':n.urlSet?'Saved · off':'Not configured';
      pill.className='src-pill'+(on?' app':n.urlSet?' env':'');
    }
  }catch(e){/* admin-only */}
}
function wireNotifications(){
  if(!$('#set-n-save')) return;
  const body=()=>({
    enabled:$('#set-n-enabled').checked,
    url:$('#set-n-url').value.trim(),
    events:{
      submitted:$('#set-n-ev-submitted').checked,
      approved:$('#set-n-ev-approved').checked,
      rejected:$('#set-n-ev-rejected').checked,
      error:$('#set-n-ev-error').checked
    }
  });
  $('#set-n-save').onclick=async()=>{
    const b=body();
    if(b.enabled&&!b.url&&!/Saved/.test($('#set-n-url').placeholder)){toast('Enter a webhook URL first','err');return;}
    const btn=$('#set-n-save');btn.disabled=true;const t=btn.textContent;btn.textContent='Saving…';
    try{
      await API('/api/admin/settings/notifications',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
      toast(b.enabled?'Saved — notifications are on':'Saved — notifications are off');
      $('#set-n-url').value='';
      loadSettings();
    }catch(e){toast(e.message,'err');}
    btn.disabled=false;btn.textContent=t;
  };
  $('#set-n-test').onclick=async()=>{
    const btn=$('#set-n-test');btn.disabled=true;const t=btn.textContent;btn.textContent='Sending…';
    try{
      const r=await API('/api/admin/settings/notifications/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:$('#set-n-url').value.trim()})});
      if(r.ok) showTestLine('set-n-result',true,'✓ Test sent — check your '+(r.flavour==='Discord'?'Discord channel':'webhook receiver'));
      else showTestLine('set-n-result',false,'✕ '+(r.error||'Could not deliver'));
    }catch(e){showTestLine('set-n-result',false,'✕ '+e.message);}
    btn.disabled=false;btn.textContent=t;
  };
  $('#set-n-reset').onclick=async()=>{
    if(!confirm('Remove the saved webhook and turn notifications off?'))return;
    try{
      await API('/api/admin/settings/notifications',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({clear:true})});
      toast('Notifications cleared');
      $('#set-n-result').className='test-line hidden';
      loadSettings();
    }catch(e){toast(e.message,'err');}
  };
}
function showTestLine(id,ok,msg){
  const el=$('#'+id); if(!el) return;
  el.className='test-line '+(ok?'ok':'err');
  el.textContent=msg;
}
function wireSettingsService(svc,p){ // p is the id prefix, e.g. 'b' for #set-b-*
  const el=id=>$('#set-'+p+'-'+id);
  if(!el('save')) return;
  const url=()=>el('url').value.trim();
  const key=()=>el('key').value.trim();
  // After a change, refresh EVERYTHING that depends on the connection so the
  // sidebar pills, request-modal profiles, and settings view all update at once.
  const refreshAll=()=>{loadSettings();checkAllStatus();loadOptions();};
  el('test').onclick=async()=>{
    const btn=el('test');btn.disabled=true;const t=btn.textContent;btn.textContent='Testing…';
    try{
      const r=await API('/api/admin/settings/integrations/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:svc,url:url(),apiKey:key()})});
      if(r.connected) showTestLine('set-'+p+'-result',true,'✓ Connected — '+(r.appName||svc)+(r.version?' v'+r.version:''));
      else showTestLine('set-'+p+'-result',false,'✕ '+(r.error||'Cannot connect'));
    }catch(e){showTestLine('set-'+p+'-result',false,'✕ '+e.message);}
    btn.disabled=false;btn.textContent=t;
  };
  el('save').onclick=async()=>{
    if(!url()){toast('Enter the URL first','err');return;}
    const btn=el('save');btn.disabled=true;const t=btn.textContent;btn.textContent='Saving…';
    try{
      await API('/api/admin/settings/integrations',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:svc,url:url(),apiKey:key()})});
      toast('Saved — applied everywhere immediately');
      el('key').value='';
      refreshAll();
    }catch(e){toast(e.message,'err');}
    btn.disabled=false;btn.textContent=t;
  };
  el('reset').onclick=async()=>{
    if(!confirm('Remove the app-saved settings for this service and use the .env values again?'))return;
    try{
      await API('/api/admin/settings/integrations',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:svc,clear:true})});
      toast('Reset — using .env values');
      refreshAll();
    }catch(e){toast(e.message,'err');}
  };
}

/* ─ Request modal (search → pick → quality) ──────────────── */
function populateModalOptions(kind){
  const qSel=$('#req-quality'), mSel=$('#req-metadata'), rSel=$('#req-root');
  // Profile ids come from an upstream service, so they are untrusted input like any
  // other API response — escape them into the attribute rather than assuming they're
  // always plain integers.
  // Audiobooks are Listenarr's, everything else is Chaptarr's. Listenarr only asks
  // for a quality profile, so the other two selects stay empty and hidden.
  const isAudio=kind==='audio';
  const B=(isAudio?opts.listenarr:opts.chaptarr)||{};
  qSel.innerHTML=(B.qualityProfiles||[]).map(q=>`<option value="${esc(q.id)}">${esc(q.name||('Quality '+q.id))}</option>`).join('')||'<option value="0">No quality profiles</option>';
  mSel.innerHTML=(B.metadataProfiles||[]).map(m=>`<option value="${esc(m.id)}">${esc(m.name||('Metadata '+m.id))}</option>`).join('')||'<option value="0">No metadata profiles</option>';
  rSel.innerHTML=(B.rootFolders||[]).map(r=>`<option value="${esc(r.path||r.id||'')}">${esc(r.path||r.name||'Root')}</option>`).join('')||'<option value="">No root folders</option>';
}
function renderReqResults(){
  const kind=reqKind;
  if(!reqResults.length){$('#req-results').innerHTML='<div class="small" style="padding:8px 4px">No matches — try a different search.</div>';return;}
  $('#req-results').innerHTML=reqResults.map((it,i)=>{
    const title=kind==='author'?it.name:it.title;
    const cover=it.image||fallback(title);
    const bits=[];
    if(it.author&&kind!=='author') bits.push(esc(it.author));
    if(it.narrator) bits.push('Narr. '+esc(it.narrator));
    if(it.year) bits.push(esc(String(it.year).slice(0,4)));
    const asin=(kind==='audio'&&(it.asin||it.key))?`<div class="rr-asin">ASIN ${esc(it.asin||it.key)}</div>`:'';
    return `<button type="button" class="req-result" data-idx="${i}"><img src="${esc(cover)}" alt=""><div class="rr-info"><div class="rr-title">${esc(title)}</div><div class="rr-sub">${bits.join(' · ')||(kind==='audio'?'Audiobook':kind==='author'?'Author':'eBook')}</div>${asin}</div></button>`;
  }).join('');
  // Flag rows already in the library / already requested. ONE batch call for the whole
  // list — this used to issue a separate GET per result, so a debounced search over
  // ~24 results fired ~24 requests on every keystroke boundary (easily a hundred in a
  // few seconds, enough to trip the API rate limiter on its own).
  // The sequence guard stops badges from a superseded search landing on new rows.
  const seq=reqSeq;
  const payload=reqResults.map(it=>({
    kind,
    title:kind==='author'?(it.name||it.title||''):(it.title||it.name||''),
    author:it.author||(kind==='author'?(it.name||''):''),
    asin:kind==='audio'?(it.asin||it.key||''):''
  }));
  const applyReqBadge=(i,r)=>{
    reqResults[i]&&(reqResults[i]._lib=r);   // cached for the submit-time warning
    if(seq!==reqSeq||!r||(!r.inLibrary&&!r.alreadyRequested)) return;
    const el=$('#req-results').querySelector('.req-result[data-idx="'+i+'"]');
    if(!el||el.querySelector('.rr-lib'))return;
    const tag=document.createElement('span');
    tag.className='rr-lib';
    if(r.inLibrary){
      el.classList.add('in-library');
      tag.textContent='✓ In library';tag.title=r.label||'Already in your library';
    }else{
      el.classList.add('already-requested');
      tag.textContent=r.alreadyRequested.status==='pending'?'⏳ Requested':'↻ Requested';
      tag.title=requestedLabel(r.alreadyRequested);
    }
    (el.querySelector('.rr-info')||el).appendChild(tag);
  };
  API('/api/library/check-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:payload})})
    .then(d=>{(d&&Array.isArray(d.results)?d.results:[]).forEach((r,i)=>applyReqBadge(i,r));})
    .catch(()=>{ /* older server without the batch endpoint — fall back to per-item */
      reqResults.forEach(async(it,i)=>applyReqBadge(i,await libraryCheck(kind,it)));
    });
}
async function reqSearch(live){
  const q=$('#req-search-input').value.trim();
  if(!q){reqSeq++;$('#req-results').innerHTML='';return;}
  const type=reqKind==='audio'?'audio':reqKind==='author'?'authors':'books';
  const seq=++reqSeq;
  if(!live) $('#req-results').innerHTML='<div class="small" style="padding:8px 4px">Searching…</div>';
  try{
    const d=await API('/api/search?type='+type+'&q='+encodeURIComponent(q));
    if(seq!==reqSeq) return;   // superseded by a newer search
    reqResults=type==='audio'?(d.audio||[]):type==='authors'?(d.authors||[]):(d.books||[]);
    renderReqResults();
    // keep the currently-selected row highlighted if it matches one of the results
    if(current){const i=reqResults.findIndex(r=>(r.key&&r.key===current.key)||(r.asin&&r.asin===current.asin));if(i>=0)$$('.req-result').forEach(el=>el.classList.toggle('selected',Number(el.dataset.idx)===i));}
  }catch(e){if(seq===reqSeq)$('#req-results').innerHTML='<div class="small" style="padding:8px 4px">'+esc(e.message)+'</div>';}
}
function selectItem(it){
  if(!it) return;
  const kind=reqKind, isAudio=kind==='audio';
  current=it;
  const title=kind==='author'?(it.name||it.title):(it.title||it.name);
  $('#req-image').src=it.image||fallback(title);
  $('#req-title').textContent=title||'—';
  $('#req-author').textContent=it.author||(isAudio?'Audiobook':kind==='author'?'Author':'eBook');
  $('#req-asin').textContent=(isAudio&&(it.asin||it.key))?('ASIN '+(it.asin||it.key)):'';
  populateModalOptions(kind);
  // Listenarr identifies an audiobook by its ASIN and files it under its own single
  // root folder, so it only needs a quality profile. Chaptarr adds an AUTHOR, which
  // needs a metadata profile and a root folder as well.
  $('#req-metadata-field').classList.toggle('hidden',isAudio);
  $('#req-root-field').classList.toggle('hidden',isAudio);
  $('#req-preview').classList.remove('hidden');
  $('#req-fields').classList.remove('hidden');
  const sb=$('#submit-request');
  // If this account isn't auto-approved, requests are held for an admin — say so
  // on the button instead of pretending it goes straight to the downloader.
  sb.textContent=(me&&me.autoApproved===false)?'Submit for approval':(isAudio?'Send to Listenarr':'Send to Chaptarr');
  // Still being sent from an earlier click? Then the button stays claimed.
  sb.disabled=submitting.has(submitKey(kind,it));
  if(sb.disabled) sb.textContent='Sending…';
}
function selectReqResult(i){
  selectItem(reqResults[i]);
  $$('.req-result').forEach(el=>el.classList.toggle('selected',Number(el.dataset.idx)===i));
}
function openRequestFromPayload(p){
  const kind=p.name?'author':(p.audio?'audio':'book');
  reqKind=kind; reqResults=[]; current=null;
  $('#req-modal-title').textContent=kind==='audio'?'Request Audiobook':kind==='author'?'Request Author':'Request eBook';
  $('#req-search-input').value=p.name||p.title||'';
  $('#req-results').innerHTML='';
  $('#req-preview').classList.add('hidden');$('#req-fields').classList.add('hidden');
  $('#submit-request').disabled=true;$('#submit-request').textContent='Send';
  openModal('request-modal');
  // Pre-select what you clicked so you can send right away…
  selectItem(p);
  // Surface "already in library" / "already requested" right away, before the user
  // fills in profiles and hits send.
  libraryCheck(kind,p).then(r=>{
    p._lib=r;
    if(r&&r.inLibrary) toast(r.label||'Already in your library','info');
    else if(r&&r.alreadyRequested) toast(requestedLabel(r.alreadyRequested),'info');
    // The author is in Chaptarr, or the downloader has the title but never got it:
    // say what sending will do (search for it) rather than nothing at all.
    else if(r&&(r.missing||r.authorInLibrary)&&r.label) toast(r.label,'info');
  });
  // …and run the search so you can pick a more precise match if you want.
  if($('#req-search-input').value.trim()) reqSearch();
}

// Titles being submitted right now. The button used to stay clickable through the
// library check below, so a double-click sent the same request twice, in parallel.
const submitting=new Set();
const submitKey=(kind,p)=>[kind,p.asin||p.key||'',norm(p.title||p.name||''),norm(p.author||'')].join('|');
async function submitCurrent(){
  const p=current; if(!p){toast('Pick a result from the list first','err');return;}
  const kind=reqKind, isAudio=kind==='audio';
  const key=submitKey(kind,p);
  if(submitting.has(key)) return;
  // Claim the button BEFORE the first await.
  submitting.add(key);
  const sb=$('#submit-request'); const old=sb.textContent;
  sb.disabled=true; sb.textContent='Checking…';
  // Hand the button back — unless the user has since picked a different title.
  const release=()=>{submitting.delete(key);if(current&&submitKey(reqKind,current)===key){sb.disabled=false;sb.textContent=old;}};
  try{
    // Already-in-library guard: pop up before sending so users don't duplicate.
    let lib=p._lib;
    if(!lib){ lib=await libraryCheck(kind,p); p._lib=lib; }
    if(current!==p){release();return;}   // they picked something else while we checked
    const what=isAudio?'audiobook':kind==='author'?'author':'book';
    if(lib&&!lib.inLibrary&&lib.alreadyRequested){
      // Not in the library yet, but somebody already asked for it — name who and when
      // instead of silently creating a duplicate request.
      const ar=lib.alreadyRequested;
      const msg=ar.status==='pending'
        ? 'This '+what+' is already waiting for admin approval ('+requestedLabel(ar)+').\n\nSubmit another request anyway?'
        : 'This '+what+' has already been requested ('+requestedLabel(ar)+') and sent to the downloader.\n\nRequest it again anyway?';
      if(!window.confirm(msg)){
        toast('Skipped — already requested','info');
        release();return;
      }
    }
    // Only for something that is really THERE. A book whose author is in Chaptarr, or a
    // title the downloader has but never downloaded, isn't — and requesting it is
    // exactly how it gets searched for — so those go straight through.
    if(lib&&lib.inLibrary){
      if(!window.confirm((lib.label||'Already in your library')+'.\n\nThis '+what+' looks like it\u2019s already there. Request it anyway?')){
        toast('Skipped — already in library','info');
        release();return;
      }
    }
    const body={kind:isAudio?'audio':kind,title:p.title||p.name||'',author:p.author||'',narrator:p.narrator||'',image:p.image||'',year:p.year||'',description:p.description||''};
    body.qualityProfileId=Number($('#req-quality').value||0);
    if(isAudio){
      // Listenarr looks the title up by ASIN, so that's the one identifier it needs.
      body.asin=p.asin||p.key||'';
    }else{
      body.foreignAuthorId=kind==='author'?(p.key||''):'';
      body.bookId=kind!=='author'?(p.key||''):'';
      if(p.raw&&typeof p.raw==='object'&&kind==='author') body.authorRaw=p.raw;
      body.metadataProfileId=Number($('#req-metadata').value||0);
      body.rootFolderPath=$('#req-root').value;
    }
    sb.textContent='Sending…';
    const r=await API('/api/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    toast(r.status==='pending'?'Request submitted — waiting for admin approval':(r.message||'Request sent'),
          r.status==='error'?'err':r.status==='pending'?'info':'ok');
    if(r.status==='error'){release();}   // keep dialog open so the error is visible
    else{submitting.delete(key);closeModal('request-modal');loadMe();loadRequests();if(me.role==='admin')loadNotifications();}
  }catch(e){toast(e.message,'err');release();}
}

/* ─ Search ───────────────────────────────────────────────── */
// Live search: fires as you type (debounced). Sequence counters make sure a
// slow response from an older keystroke can never overwrite newer results.
const debounce=(fn,ms)=>{let t;const d=(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)};d.cancel=()=>clearTimeout(t);return d};
let searchSeq=0,reqSeq=0;
const MIN_LIVE_Q=2;   // don't auto-search on a single character

async function doSearch(live){
  const q=$('#search-input').value.trim();
  if(!q){searchSeq++;$('#search-results').innerHTML='';return;}
  const type=$('#search-type').value;
  const seq=++searchSeq;
  // While live-typing, keep the previous results on screen instead of
  // flashing "Searching…" on every keystroke.
  if(!live) $('#search-results').innerHTML='<div class="small" style="padding:16px">Searching…</div>';
  const box=$('#search-results');
  try{
    const d=await API('/api/search?type='+encodeURIComponent(type)+'&q='+encodeURIComponent(q));
    if(seq!==searchSeq) return;   // superseded by a newer search

    // ── "Everything": eBooks and audiobooks together, in labelled groups ──
    // The API has always supported type=all; this surfaces it. Each group gets its
    // own container so data-libidx stays 0-based per group and the existing
    // annotateLibrary()/badging path works unchanged.
    if(type==='all'){
      const groups=[
        {key:'books', label:'eBooks',     items:d.books ||[], cardType:'book'},
        {key:'audio', label:'Audiobooks', items:d.audio ||[], cardType:'audio'},
        {key:'authors',label:'Authors',   items:(d.authors||[]).slice(0,12), cardType:'author'}
      ].filter(g=>g.items.length);
      box.className='';   // groups bring their own .grid; the outer box must not be one
      if(!groups.length){box.innerHTML='<div class="small" style="padding:16px">No results found</div>';return;}
      box.innerHTML=groups.map(g=>
        '<div class="section-head"><h2>'+esc(g.label)+
        ' <span class="muted" style="font-weight:400">('+g.items.length+')</span></h2></div>'+
        '<div class="grid" data-group="'+g.key+'">'+
        g.items.map((it,i)=>card(it,g.cardType).replace('<article class="tile"','<article class="tile" data-libidx="'+i+'"')).join('')+
        '</div>'
      ).join('');
      groups.forEach(g=>annotateLibrary(box.querySelector('.grid[data-group="'+g.key+'"]'),g.items,g.cardType,()=>seq===searchSeq));
      return;
    }

    let items=[],cardType;
    if(type==='authors'){items=d.authors||[];cardType='author';}
    else if(type==='audio'){items=d.audio||[];cardType='audio';}
    else {items=d.books||[];cardType='book';}
    box.className='grid';
    box.innerHTML=items.map((it,i)=>card(it,cardType).replace('<article class="tile"','<article class="tile" data-libidx="'+i+'"')).join('')
      ||'<div class="small" style="padding:16px">No results found</div>';
    annotateLibrary(box,items,cardType,()=>seq===searchSeq);
  }catch(e){if(seq===searchSeq){box.className='grid';box.innerHTML='<div class="small" style="padding:16px">'+esc(e.message)+'</div>';}}
}

// Check each visible result against the library and flag the ones already present.
// Runs after render so results show instantly; badges appear as checks complete.
// Uses the batch endpoint (one round-trip for the whole list) and falls back to
// per-item checks if that endpoint isn't available (older server builds).
// How long ago, in plain words — used by the duplicate-request badge.
function timeAgo(d){
  if(!d) return '';
  const s=Math.max(0,(Date.now()-new Date(d).getTime())/1000);
  if(s<90) return 'just now';
  const m=s/60; if(m<60) return Math.round(m)+' min ago';
  const h=m/60; if(h<24) return Math.round(h)+'h ago';
  const dd=h/24; if(dd<30) return Math.round(dd)+' day'+(Math.round(dd)===1?'':'s')+' ago';
  return 'on '+new Date(d).toLocaleDateString();
}
function requestedLabel(ar){
  if(!ar) return '';
  const who=ar.username?('by '+ar.username):'';
  const when=timeAgo(ar.createdAt);
  return (ar.status==='pending'?'Awaiting approval':'Already requested')+(who?' '+who:'')+(when?' · '+when:'');
}
function applyLibBadge(container,i,r){
  if(!r) return;
  const tile=container.querySelector('.tile[data-libidx="'+i+'"]');
  if(!tile) return;
  if(r.inLibrary&&!tile.querySelector('.lib-badge')){
    tile.classList.add('in-library');
    const b=document.createElement('span');
    b.className='lib-badge';
    b.textContent='✓ In library';
    b.title=r.label||'Already in your library';
    (tile.querySelector('.imgwrap')||tile).appendChild(b);
  }
  // A pending/sent request isn't in the library yet, so the check above says no —
  // flag it separately so two people don't request the same title.
  if(r.alreadyRequested&&!r.inLibrary&&!tile.querySelector('.req-badge-tile')){
    tile.classList.add('already-requested');
    const b=document.createElement('span');
    b.className='lib-badge req-badge-tile';
    b.textContent=r.alreadyRequested.status==='pending'?'⏳ Requested':'↻ Requested';
    b.title=requestedLabel(r.alreadyRequested);
    (tile.querySelector('.imgwrap')||tile).appendChild(b);
  }
}
async function annotateLibrary(container,items,kind,stillValid){
  if(!container||!items.length) return;
  const ok=()=>!stillValid||stillValid();   // drop late results from a superseded search
  // Build the per-item payload the same way libraryCheck() does for a single item.
  const payload=items.map(it=>({
    kind,
    title:kind==='author'?(it.name||it.title||''):(it.title||it.name||''),
    author:it.author||(kind==='author'?(it.name||''):''),
    asin:kind==='audio'?(it.asin||it.key||''):''
  }));
  try{
    const d=await API('/api/library/check-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:payload})});
    if(!ok()) return;
    const results=(d&&Array.isArray(d.results))?d.results:[];
    results.forEach((r,i)=>applyLibBadge(container,i,r));
  }catch(e){
    // Fallback: per-item checks (still correct, just chattier).
    items.forEach(async (it,i)=>{ const r=await libraryCheck(kind,it); if(ok()) applyLibBadge(container,i,r); });
  }
}

/* ─ Copy helper ──────────────────────────────────────────── */
function copyText(t){
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(()=>toast('Copied to clipboard')).catch(()=>toast('Copy failed','err'));}
  else{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');toast('Copied to clipboard');}catch{toast('Copy failed','err');}ta.remove();}
}

/* ─ Wire events ──────────────────────────────────────────── */
function wire(){
  $$('.nav').forEach(b=>b.addEventListener('click',()=>showPage(b.dataset.page)));
  $('#logout-btn').onclick=()=>{localStorage.removeItem('bs_token');location.href='/login.html'};
  wireSettingsService('chaptarr','b');
  wireSettingsService('listenarr','l');
  wireNotifications();
  $('#account-btn')&&($('#account-btn').onclick=()=>{
    $('#acc-current').value='';$('#acc-new').value='';$('#acc-confirm').value='';
    openModal('account-modal');
    setTimeout(()=>$('#acc-current').focus(),50);
  });
  // ── Live search: results populate as you type (350ms debounce) ──
  const liveSearch=debounce(()=>{
    const q=$('#search-input').value.trim();
    if(q.length>=MIN_LIVE_Q) doSearch(true);
    else if(!q){searchSeq++;$('#search-results').innerHTML='';}
  },350);
  $('#search-btn').onclick=()=>{liveSearch.cancel();doSearch();};
  $('#search-input').addEventListener('input',liveSearch);
  $('#search-input').addEventListener('keydown',e=>{if(e.key==='Enter'){liveSearch.cancel();doSearch();}});
  // Changing the type (Books/Authors/Audio) re-runs the current query.
  $('#search-type').addEventListener('change',()=>{if($('#search-input').value.trim())doSearch();});
  $('#submit-request').onclick=submitCurrent;
  const liveReqSearch=debounce(()=>{
    const q=$('#req-search-input').value.trim();
    if(q.length>=MIN_LIVE_Q) reqSearch(true);
    else if(!q){reqSeq++;$('#req-results').innerHTML='';}
  },350);
  $('#req-search-btn').onclick=()=>{liveReqSearch.cancel();reqSearch();};
  $('#req-search-input').addEventListener('input',liveReqSearch);
  $('#req-search-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();liveReqSearch.cancel();reqSearch();}});
  $('#add-user-btn')&&($('#add-user-btn').onclick=()=>{
    $('#user-modal-title').textContent='Add User';
    $('#u-name').value='';$('#u-pass').value='';$('#u-role').value='user';$('#u-limit').value='10';$('#u-can').checked=true;$('#u-auto').value='default';
    window.__editUserId=null;
    openModal('user-modal');
  });
  // ── All Requests: status filter chips + clickable counter cards ──
  const fbar=$('#req-filter');
  if(fbar) fbar.addEventListener('click',e=>{
    const b=e.target.closest('.fbtn'); if(b) setReqFilter(b.dataset.status);
  });
  const sbar=$('#req-stats');
  if(sbar) sbar.addEventListener('click',e=>{
    const c=e.target.closest('.stat-card'); if(c) setReqFilter(c.dataset.status);
  });
  // ── Settings: save the global auto-approve toggle ──
  $('#set-a-save')&&($('#set-a-save').onclick=async()=>{
    const btn=$('#set-a-save');btn.disabled=true;const t=btn.textContent;btn.textContent='Saving…';
    try{
      await API('/api/admin/settings/approvals',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoApproveAll:$('#set-approve-all').checked})});
      toast($('#set-approve-all').checked?'Saved — new requests are auto-approved':'Saved — new requests now need your approval');
      loadSettings();
    }catch(e){toast(e.message,'err');}
    btn.disabled=false;btn.textContent=t;
  });
  $('#save-account')&&($('#save-account').onclick=()=>{
    const cur=$('#acc-current').value, nw=$('#acc-new').value, cf=$('#acc-confirm').value;
    if(!cur||!nw){toast('Fill in your current and new password','err');return;}
    if(nw.length<6){toast('New password must be at least 6 characters','err');return;}
    if(nw!==cf){toast('New passwords do not match','err');return;}
    const btn=$('#save-account');btn.disabled=true;const old=btn.textContent;btn.textContent='Updating…';
    API('/api/account/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cur,newPassword:nw})})
      // The server rotates every session on a password change and hands back a
      // replacement token for THIS device — store it, or we'd immediately 401
      // ourselves out of the app we just secured.
      .then(d=>{if(d&&d.token)localStorage.setItem('bs_token',d.token);toast('Password updated — other devices signed out');closeModal('account-modal');})
      .catch(er=>toast(er.message,'err'))
      .finally(()=>{btn.disabled=false;btn.textContent=old;});
  });
  $('#logout-all')&&($('#logout-all').onclick=()=>{
    if(!confirm('Sign out of BookSeerr on every other device?\n\nThis device stays signed in.'))return;
    const btn=$('#logout-all');btn.disabled=true;const old=btn.textContent;btn.textContent='Revoking…';
    API('/api/account/logout-all',{method:'POST'})
      .then(d=>{if(d&&d.token)localStorage.setItem('bs_token',d.token);toast('All other sessions signed out');})
      .catch(er=>toast(er.message,'err'))
      .finally(()=>{btn.disabled=false;btn.textContent=old;});
  });
  $('#add-key-btn')&&($('#add-key-btn').onclick=()=>{$('#k-name').value='';openModal('apikey-modal');});
  $('#save-key')&&($('#save-key').onclick=()=>{
    const name=$('#k-name').value.trim();
    API('/api/apikeys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})
      .then(k=>{toast('API key created');closeModal('apikey-modal');loadApiKeys();})
      .catch(er=>toast(er.message,'err'));
  });
  document.body.addEventListener('click',e=>{
    const rr=e.target.closest('.req-result');
    if(rr){selectReqResult(Number(rr.dataset.idx));return}
    const b=e.target.closest('[data-kind]');
    if(b){let p={};try{p=JSON.parse(b.dataset.payload)}catch{};openRequestFromPayload(p);return}
    const sl=e.target.closest('.slider-btn');
    if(sl){const tr=document.getElementById(sl.dataset.target);tr.scrollBy({left:(Number(sl.dataset.dir)||1)*tr.clientWidth*0.82,behavior:'smooth'});return}
    // Approve a pending request (or Retry an errored one) — this is the moment it
    // actually gets sent to Chaptarr.
    const ap=e.target.closest('[data-approve]');
    if(ap){
      const id=String(ap.dataset.approve);
      if(inFlightRequests.has(id)) return;          // already sending — ignore the double click
      inFlightRequests.add(id);
      ap.disabled=true;const t=ap.textContent;ap.textContent='Sending…';
      API('/api/requests/'+id+'/approve',{method:'POST'})
        .then(r=>{toast(r.status==='sent'?('✓ Approved — '+(r.message||'sent')):(r.message||'Send failed'),r.status==='sent'?'ok':'err');loadNotifications();loadMe();})
        .catch(er=>{toast(er.message,'err');ap.disabled=false;ap.textContent=t;})
        .finally(()=>{inFlightRequests.delete(id);loadRequests();});
      return
    }
    const rj=e.target.closest('[data-reject]');
    if(rj){
      if(!confirm('Reject this request? Nothing will be sent to the downloader.'))return;
      API('/api/requests/'+rj.dataset.reject+'/reject',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})})
        .then(()=>{toast('Request rejected');loadRequests();loadNotifications();})
        .catch(er=>toast(er.message,'err'));
      return
    }
    const du=e.target.closest('[data-delreq]');
    if(du){API('/api/requests/'+du.dataset.delreq,{method:'DELETE'}).then(()=>{toast('Deleted');loadRequests();loadMe()}).catch(er=>toast(er.message,'err'));return}
    const ck=e.target.closest('[data-copykey]');
    if(ck){copyText(ck.dataset.copykey);return}
    const dk=e.target.closest('[data-delkey]');
    if(dk){if(confirm('Revoke this API key? Programs using it will stop working.')) API('/api/apikeys/'+dk.dataset.delkey,{method:'DELETE'}).then(()=>{toast('Revoked');loadApiKeys()}).catch(er=>toast(er.message,'err'));return}
    const eu=e.target.closest('[data-edituser]');
    if(eu){
      window.__editUserId=eu.dataset.edituser;
      API('/api/users').then(users=>{
        const u=users.find(x=>String(x.id)===String(eu.dataset.edituser));
        $('#user-modal-title').textContent='Edit User';
        $('#u-name').value=u.username;$('#u-pass').value='';$('#u-role').value=u.role;$('#u-limit').value=u.limit;$('#u-can').checked=!!u.canRequest;$('#u-auto').value=u.autoApprove||'default';
        openModal('user-modal');
      });return
    }
    const sv=e.target.closest('#save-user');
    if(sv){
      const body={username:$('#u-name').value.trim(),password:$('#u-pass').value,role:$('#u-role').value,limit:Number($('#u-limit').value||0),canRequest:$('#u-can').checked,autoApprove:$('#u-auto').value};
      const done=window.__editUserId
        ?API('/api/users/'+window.__editUserId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
        :API('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      done.then(()=>{toast('Saved');closeModal('user-modal');window.__editUserId=null;loadUsers()}).catch(er=>toast(er.message,'err'));return
    }
    const delu=e.target.closest('[data-deluser]');
    if(delu){if(confirm('Delete this user?')) API('/api/users/'+delu.dataset.deluser,{method:'DELETE'}).then(()=>loadUsers()).catch(er=>toast(er.message,'err'))}
  });
  $$('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
  /* Password visibility toggles (login-style eye button) */
  $$('.pw-toggle').forEach(btn=>btn.addEventListener('click',()=>{
    const input=document.getElementById(btn.dataset.for);
    if(!input) return;
    const show=input.type==='password';
    input.type=show?'text':'password';
    btn.classList.toggle('showing',show);
    btn.setAttribute('aria-label',show?'Hide password':'Show password');
  }));
  /* Enter submits the user / api-key modals */
  $('#user-modal').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.classList.contains('input')){e.preventDefault();$('#save-user').click();}});
  $('#apikey-modal')&&$('#apikey-modal').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.classList.contains('input')){e.preventDefault();$('#save-key').click();}});
  $('#account-modal')&&$('#account-modal').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.classList.contains('input')){e.preventDefault();$('#save-account').click();}});
  $('#request-modal').addEventListener('click',e=>{if(e.target.id==='request-modal') closeModal('request-modal')});
  $('#user-modal').addEventListener('click',e=>{if(e.target.id==='user-modal') closeModal('user-modal')});
  $('#apikey-modal')&&$('#apikey-modal').addEventListener('click',e=>{if(e.target.id==='apikey-modal') closeModal('apikey-modal')});
  $('#account-modal')&&$('#account-modal').addEventListener('click',e=>{if(e.target.id==='account-modal') closeModal('account-modal')});
}

/* ─ Boot ─────────────────────────────────────────────────── */
(async()=>{
  // Only ONE thing decides whether we're signed in: whether /api/me works. Everything
  // after it is page content, and a hiccup loading page content is not a reason to
  // throw the session away. The old code wrapped the whole boot in a single catch that
  // called forceSignOut(), so one 502 from the proxy — or simply tripping the API rate
  // limiter — deleted the token and bounced the user to the login screen.
  // A genuine auth failure still signs out: API() does that on any 401.
  try{
    if(!localStorage.getItem('bs_token')) {location.href='/login.html';return}
    await loadMe();
  }catch(e){
    forceSignOut('Could not verify your session — please sign in again.');
    return;
  }
  try{
    // One-time migration: older builds tracked the last-seen request in
    // localStorage (per-browser). Push that marker to the server once so this
    // browser's history counts everywhere, then stop using localStorage for it.
    // (The server clamps the value, so a bogus number can't skip real ones.)
    const legacySeen=Number(localStorage.getItem('bs_lastSeenReq')||0);
    if(me.role==='admin'&&legacySeen>0){
      try{await API('/api/notifications/seen',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lastSeenRequestId:legacySeen})});}catch(e){}
    }
    try{localStorage.removeItem('bs_lastSeenReq');}catch(e){}
    wire();
    // allSettled, not all: one failing panel must not abort the rest of the boot.
    await Promise.allSettled([
      checkAllStatus(),
      loadOptions(),
      loadForYou(),
      loadDiscover(),
      loadRequests(),
      loadUsers(),
      loadApiKeys(),
      loadNotifications(),
      loadSettings()
    ]);
    // Show the real server version in the sidebar (no more hardcoded drift).
    fetch('/healthz').then(r=>r.json()).then(d=>{const v=$('#app-version');if(v&&d.version)v.textContent='BookSeerr v'+d.version;}).catch(()=>{});
    setInterval(()=>{checkAllStatus();}, 60000);
    // EVERYONE polls the server-side state so changes made in ANOTHER browser or
    // on your phone (new requests, notifications checked elsewhere, edited users,
    // settings changes) show up here without a manual reload. All state lives in
    // db.json on the server — every device reads the same source of truth.
    if(me.role==='admin'){
      setInterval(()=>{ loadRequests(); loadUsers(); loadApiKeys(); loadNotifications(); loadMe(); }, 20000);
    }else{
      setInterval(()=>{ loadRequests(); loadMe(); }, 30000);
    }
  }catch(e){
    // We're authenticated (loadMe succeeded) — this is a content failure. Say so and
    // leave the user signed in; the pollers will fill the page in when it recovers.
    console.error('[BookSeerr] startup problem:',e);
    toast('Some panels failed to load — retrying in the background','err');
  }
})();
