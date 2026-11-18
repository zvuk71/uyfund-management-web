import {GitHubStorage, MAX_FILE_BYTES} from './github-sync.js';
const KEY = 'uyfund-management-v2';
const DB_NAME = 'uyfund-attachments-v1';
const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => globalThis.crypto?.randomUUID?.() || `u-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const today = () => new Date().toISOString().slice(0, 10);
const money = n => (n === '' || n === null || n === undefined || !Number.isFinite(Number(n))) ? '—' : new Intl.NumberFormat('uk-UA').format(Number(n)) + ' ¥';
const dateLabel = s => s ? esc(String(s).slice(0,10)) : '—';
const entityNames = {projects:'Проєкти',grants:'Гранти',concerts:'Концерти'};
const singular = {projects:'проєкт',grants:'заявку',concerts:'концерт'};
const documentField = {projects:'attachments',grants:'documents',concerts:'attachments'};
const tabs = [{id:'overview',name:'Огляд',icon:'▦'},{id:'projects',name:'Проєкти',icon:'◇'},{id:'grants',name:'Гранти',icon:'▤'},{id:'concerts',name:'Концерти',icon:'♫'},{id:'calendar',name:'Календар',icon:'▦'},{id:'files',name:'Файли',icon:'▣'}];
let serverMode = false, githubMode = false, githubClient = null, csrfToken = '', serverRevision = 0, persistPaused = false, persistChain = Promise.resolve();
let state, baseSeed, tab = 'overview', selected = null, modal = null, search = '', statusFilter = '', projectFilter = '', month = new Date().toISOString().slice(0,7), busy = false;
const fields = {
 projects:[['name','Назва','text',true],['description','Детальний опис','textarea'],['status','Статус','text'],['startDate','Початок','date'],['endDate','Завершення','date']],
 grants:[['grantName','Назва конкурсу','text',true],['officialName','Офіційна назва','text'],['program','Програма (наприклад, SEAG)','text'],['projectId','Пов’язаний проєкт','project'],['projectTitle','Назва проєкту в заявці','text'],['status','Статус','text'],['category','Категорія','text'],['deadline','Дедлайн','date'],['resultDate','Очікуваний результат','date'],['submittedAt','Дата подання','date'],['requested','Запит (¥)','number'],['totalBudget','Загальний бюджет (¥)','number'],['ownFunds','Власні кошти (¥)','number'],['maxAward','Максимум конкурсу (¥)','number'],['confirmation','Номер підтвердження','text'],['owner','Відповідальний','text'],['officialSource','Офіційне URL','url'],['source','Джерело даних','textarea'],['verification','Статус перевірки джерела','text'],['criteria','Критерії та вимоги','textarea'],['nextStep','Наступний крок','textarea'],['notes','Примітки','textarea']],
 concerts:[['title','Назва концерту','text',true],['projectId','Проєкт','project',true],['grantId','Пов’язаний грант (необов’язково)','grant'],['status','Статус','text'],['date','Дата','date'],['startTime','Початок','time'],['endTime','Завершення','time'],['venue','Місце','text'],['address','Адреса','text'],['websiteUrl','Сайт концерту','url'],['programText','Програма концерту','textarea']]
};
const sub = {
 projects:{participants:{label:'Учасники й контакти',fields:[['name','Ім’я'],['role','Роль'],['contact','Контакт']]},tasks:{label:'Завдання',fields:[['title','Завдання'],['assignee','Відповідальний'],['dueDate','Термін','date'],['status','Статус'],['notes','Примітки']]},links:{label:'Посилання',fields:[['label','Назва'],['url','URL','url']]}},
 grants:{budget:{label:'Статті бюджету',fields:[['item','Стаття'],['amount','Сума ¥','number'],['status','Статус'],['source','Джерело']]},checklist:{label:'Чекліст',fields:[['title','Документ або вимога'],['status','Статус'],['source','Джерело']]},actions:{label:'Завдання та наступні кроки',fields:[['title','Завдання'],['assignee','Відповідальний'],['dueDate','Дата','date'],['status','Статус'],['text','Деталі']]},links:{label:'Посилання',fields:[['label','Назва'],['url','URL','url']]},journal:{label:'Історія змін заявки',fields:[['date','Дата','date'],['text','Запис']]}} ,
 concerts:{performers:{label:'Виконавці',fields:[['name','Ім’я'],['role','Роль'],['contact','Контакт']]},guests:{label:'Запрошені гості',fields:[['name','Ім’я / група'],['partySize','Кількість','number'],['rsvpStatus','Підтвердження'],['notes','Примітки']]},rehearsals:{label:'Репетиції',fields:[['date','Дата','date'],['time','Час','time'],['venue','Місце'],['notes','Примітки']]},tasks:{label:'Завдання',fields:[['title','Завдання'],['assignee','Відповідальний'],['dueDate','Термін','date'],['status','Статус'],['notes','Примітки']]},expenses:{label:'Витрати',fields:[['item','Стаття'],['amount','Сума ¥','number'],['notes','Примітки']]},links:{label:'Посилання',fields:[['label','Назва'],['url','URL','url']]}}
};
function normalize(raw) {
 const x = structuredClone(raw || {});
 x.version = 2;
 x.organization ||= x.profile || {};
 x.projects ||= [];
 x.grants ||= [];
 x.concerts ||= [];
 x.activity ||= [];
 x.decisions ||= [];
 for (const p of x.projects) {p.participants ||= p.members || [];p.tasks ||= [];p.links ||= [];p.attachments ||= [];p.history ||= [];}
 for (const g of x.grants) {g.budget ||= [];g.checklist ||= [];g.actions ||= [];g.journal ||= [];g.documents ||= [];g.links ||= [];}
 for (const c of x.concerts) {for (const k of ['performers','guests','rehearsals','tasks','expenses','links','attachments','history']) c[k] ||= [];}
 return x;
}
function recoverGrantList(grants) {
 const archive = grants.find(g => /^(seag|seag-tbd)$/i.test(g.id) || /^SEAG$/i.test(g.grantName||g.grant||''));
 const mapping={wesley:'song-wings','wesley-domestic-2027':'song-wings',kao:'tsunagari',ntj:'tsunagari','jac-fund-2027':'tsunagari',kacf:'gashu','kacf-tbd':'gashu',momijizaka:'tsunagari'};
 const result=grants.filter(g=>g!==archive).map(g=>({...g,projectId:g.projectId||mapping[g.id]||'',grantName:g.grantName||g.grant||g.name||'Заявка',program:/^kacf/i.test(g.id)?(g.program||'SEAG — назва програми KACF (потрібна перевірка)'):(g.program||'')}));
 return {result,archive};
}
function migrateLegacy(data) {
 if (data.format === 'uyfund-management-v2' && data.state) return normalize(data.state);
 if (data.state?.apps) {
  const {result,archive}=recoverGrantList(data.state.apps.map(g=>({...g,grantName:g.grant || g.name || 'Заявка',projectTitle:g.project || '',budget:[],documents:[],actions:[],journal:g.events || [],links:[]})));
  const x = {organization:data.state.profile || {},projects:structuredClone(baseSeed.projects),grants:result,concerts:[],activity:[],migration:{seagArchived:archive||null}};
  return normalize(x);
 }
 if (Array.isArray(data.grants)) {
  const {result,archive}=recoverGrantList(data.grants);
  const x = {organization:data.profile || {},projects:structuredClone(baseSeed.projects),grants:result,concerts:[],activity:[],decisions:data.decisions || [],migration:{legacyOriginalCount:data.grants.length,seagArchived:archive||null}};
  return normalize(x);
 }
 if (data.version === 2 && Array.isArray(data.grants)) return normalize(data);
 throw new Error('Невідомий формат JSON. Потрібна резервна копія UYFund.');
}
async function api(path, options={}) {
 const headers={...options.headers};
 if(options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) && typeof options.body !== 'string'){
  headers['Content-Type']='application/json';options.body=JSON.stringify(options.body);
 }
 if(options.method && !['GET','HEAD'].includes(options.method))headers['X-CSRF-Token']=csrfToken;
 const res=await fetch(path,{credentials:'same-origin',...options,headers});
 if(!res.ok){let msg=`HTTP ${res.status}`;try{msg=(await res.json()).error||msg;}catch{};const err=new Error(msg);err.status=res.status;throw err;}
 return res;
}
function serverSave(snapshot) {
 if(persistPaused)return Promise.resolve(false);
 persistChain=persistChain.then(async()=>{
  const res=await api('/api/state',{method:'PUT',body:{state:snapshot,revision:serverRevision}});
  const result=await res.json();serverRevision=result.revision;
 }).catch(err=>{
  if(!persistPaused){
   persistPaused=true;
   download(JSON.stringify({format:'uyfund-management-v2',exportedAt:new Date().toISOString(),state},null,2),`UYFund_unsaved_emergency_${today()}.json`);
   alert(`Сервер не зберіг зміни: ${err.message}. Аварійну копію поточного стану завантажено на пристрій. Не продовжуйте редагування; зверніться до адміністратора та звірте зміни.`);
  }
  return false;
 });
 return persistChain;
}
function githubSave(snapshot) {
 if (persistPaused) return Promise.resolve(false);
 persistChain = persistChain.then(async () => {
  await githubClient.saveState(snapshot);
  return true;
 }).catch(err => {
  if (!persistPaused) {
   persistPaused = true;
   download(JSON.stringify({format:'uyfund-management-v2',exportedAt:new Date().toISOString(),state},null,2),`UYFund_unsaved_emergency_${today()}.json`);
   alert(`Синхронізацію з GitHub зупинено: ${err.message}. Аварійну копію записів завантажено. Не продовжуйте редагування. Перевірте зміни на інших пристроях перед повторним імпортом.`);
   render();
  }
  return false;
 });
 return persistChain;
}
function save(note = '', type = '', id = '') {
 if (note) {
  const entry = {date:new Date().toISOString(),text:note};
  state.activity.unshift(entry);
  if (state.activity.length > 500) state.activity.length = 500;
  const obj = state[type]?.find(v=>v.id === id);
  if (obj) {obj.history ||= [];obj.history.unshift(entry);}
 }
 if(serverMode)return serverSave(structuredClone(state));
 if(githubMode)return githubSave(structuredClone(state));
 try {localStorage.setItem(KEY, JSON.stringify(state));} catch(e) {alert('Бракує місця для метаданих у браузері. Експортуйте JSON і звільніть місце.');}
 return Promise.resolve();
}
function projectName(id) {return state.projects.find(p=>p.id === id)?.name || (id ? 'Проєкт не знайдено' : 'Не призначено');}
function grantName(id) {return state.grants.find(g=>g.id === id)?.grantName || 'Без гранту';}
function titleFor(type,x) {return x?.name || x?.grantName || x?.title || 'Без назви';}
function items(type) {return state[type] || [];}
function current() {return selected ? items(selected.type).find(x=>x.id===selected.id) : null;}
function projectOptions(value='') {return `<option value="">Не призначено</option>` + state.projects.map(p=>`<option value="${esc(p.id)}" ${p.id===value?'selected':''}>${esc(p.name)}</option>`).join('');}
function grantOptions(projectId,value='') {return `<option value="">Без гранту</option>` + state.grants.filter(g=>!projectId || g.projectId===projectId).map(g=>`<option value="${esc(g.id)}" ${g.id===value?'selected':''}>${esc(g.grantName)}</option>`).join('');}
function pill(s) {let cls=/Подано|Очікує|Активний|Відбувся/.test(s)?'green':/уточнен|Чернетка|Плануван|Залежить/.test(s)?'amber':'slate';return `<span class="pill ${cls}">${esc(s || 'Без статусу')}</span>`;}
function layout(content) {
 $('#app').innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brandmark">UYF</span><div><strong>UYFund</strong><small>Management System</small></div></div><div class="nav-label">РОБОЧИЙ ПРОСТІР</div><nav>${tabs.map(t=>`<button class="nav ${tab===t.id?'active':''}" data-nav="${t.id}"><span>${t.icon}</span>${t.name}${['projects','grants','concerts'].includes(t.id)?`<em>${items(t.id).length}</em>`:''}</button>`).join('')}</nav><div class="sidebar-bottom"><span class="local-dot"></span> ${githubMode?'GitHub · приватна синхронізація':serverMode?'Захищений сервер':'Локальний прототип'}<br><small>${githubMode?'Записи й документи зберігаються у приватному GitHub.':serverMode?'Дані в PostgreSQL. Резервні копії зберігайте поза VPS.':'Дані зберігаються у цьому браузері. Немає спільного серверного доступу.'}</small></div></aside><div class="work"><header class="topbar"><button class="mobile-menu" data-action="toggle-menu" aria-label="Меню">☰</button><label class="search"><span>⌕</span><input id="global-search" value="${esc(search)}" placeholder="Пошук проєктів, грантів, концертів…" autocomplete="off"></label><button class="btn ghost" data-action="import">Імпорт JSON</button><button class="btn ghost" data-action="export">Експорт JSON</button><button class="btn primary" data-action="create" data-type="${['projects','grants','concerts'].includes(tab)?tab:'projects'}">+ Створити</button>${githubMode?'<button class="btn ghost" data-action="github-refresh">↻ GitHub</button><button class="btn ghost" data-action="github-disconnect">Від’єднати</button>':serverMode?'<button class="btn ghost" data-action="logout">Вийти</button>':''}</header><main>${content}</main></div></div><div id="modal-root">${modal ? renderModal() : ''}</div><input id="import-input" type="file" accept=".json,application/json" hidden><input id="file-input" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,image/*" multiple hidden>`;
}
function heading(title,desc='',action='') {return `<div class="page-heading"><div><div class="eyebrow">特定非営利活動法人ウクライナ横浜基金 · UYFUND</div><h1>${esc(title)}</h1><p>${esc(desc)}</p></div>${action}</div>`;}
function renderOverview() {
 const due = state.grants.filter(g=>g.deadline).sort((a,b)=>String(a.deadline).localeCompare(String(b.deadline))).slice(-8).reverse();
 const open = state.grants.filter(g=>/Подано|Очікує/.test(g.status)).length;
 const cards = [['Проєкти',state.projects.length,'projects'],['Гранти',state.grants.length,'grants'],['Концерти',state.concerts.length,'concerts'],['Подано / очікують',open,'grants']];
 return heading('Панель керування','Єдиний простір проєктів, грантів, концертів і документів.')+`<div class="notice"><strong>Режим відновлення.</strong> Перед роботою з повними даними імпортуйте приватну резервну копію UYFund. ${githubMode?'Дані синхронізуються через приватний GitHub. Перед великим імпортом зробіть резервну копію.':serverMode?'Дані зберігаються на захищеному сервері. Перед імпортом зробіть JSON-експорт.':'Ця версія не має авторизації та серверної синхронізації — не публікуйте її з персональними даними.'}</div><div class="stats">${cards.map(c=>`<button class="stat" data-nav="${c[2]}"><span>${c[0]}</span><strong>${c[1]}</strong><small>Перейти до розділу →</small></button>`).join('')}</div><div class="columns"><section class="panel"><div class="section-head"><h2>Грантові заявки</h2><button class="text-btn" data-nav="grants">Усі заявки →</button></div>${state.grants.map(g=>`<button class="overview-row" data-open="grants" data-id="${esc(g.id)}"><div><strong>${esc(g.grantName)}</strong><small>${esc(projectName(g.projectId))}</small></div><div>${pill(g.status)}<small>Дедлайн: ${dateLabel(g.deadline)}</small></div></button>`).join('')||'<p class="muted">Заявок немає.</p>'}</section><section class="panel"><div class="section-head"><h2>Найближчі дати</h2><button class="text-btn" data-nav="calendar">Календар →</button></div>${due.map(g=>`<button class="overview-row" data-open="grants" data-id="${esc(g.id)}"><div><strong>${esc(g.grantName)}</strong><small>Дедлайн</small></div><time>${dateLabel(g.deadline)}</time></button>`).join('')||'<p class="muted">Немає встановлених дат.</p>'}<h3 class="subhead">Останні зміни</h3>${state.activity.slice(0,5).map(a=>`<p class="activity"><small>${dateLabel(a.date)}</small> ${esc(a.text)}</p>`).join('')||'<p class="muted">Поки немає нових змін.</p>'}</section></div>`;
}
function renderList(type) {
 let arr = items(type).filter(x=>{
  const q = search.toLocaleLowerCase();
  return (!q || JSON.stringify(x).toLocaleLowerCase().includes(q)) && (!statusFilter || x.status===statusFilter) && (!projectFilter || x.projectId===projectFilter);
 });
 const statuses = [...new Set(items(type).map(x=>x.status).filter(Boolean))];
 return heading(entityNames[type],`Усього записів: ${items(type).length}. Створюйте необмежену кількість пов'язаних записів.`,`<button class="btn primary" data-action="create" data-type="${type}">+ Новий запис</button>`)+`<div class="filterbar"><select id="status-filter"><option value="">Усі статуси</option>${statuses.map(s=>`<option ${s===statusFilter?'selected':''}>${esc(s)}</option>`).join('')}</select>${type!=='projects'?`<select id="project-filter"><option value="">Усі проєкти</option>${projectOptions(projectFilter).replace('<option value="">Не призначено</option>','')}</select>`:''}<span>${arr.length} результатів</span></div><div class="card-grid">${arr.map(x=>`<button class="record-card" data-open="${type}" data-id="${esc(x.id)}"><div class="record-top">${pill(x.status)}<span class="arrow">↗</span></div><h2>${esc(titleFor(type,x))}</h2>${type==='projects'?`<p>${esc(x.description || '')}</p>`:`<p>${esc(projectName(x.projectId))}</p>`}<div class="record-bottom">${type==='grants'?`<span>Запит: ${money(x.requested)}</span><span>Дедлайн: ${dateLabel(x.deadline)}</span>`:type==='concerts'?`<span>${dateLabel(x.date)} ${esc(x.startTime||'')}</span><span>${esc(x.venue||'Місце не вказано')}</span>`:`<span>Грантів: ${state.grants.filter(g=>g.projectId===x.id).length}</span><span>Концертів: ${state.concerts.filter(c=>c.projectId===x.id).length}</span>`}</div></button>`).join('')||'<div class="empty">Нічого не знайдено. Змініть фільтри або створіть запис.</div>'}</div>`;
}
function details(type,x) {
 const entries = type==='projects'?[['Статус',x.status],['Період',`${dateLabel(x.startDate)} — ${dateLabel(x.endDate)}`]]:type==='grants'?[['Офіційна назва',x.officialName],['Програма',x.program],['Проєкт',projectName(x.projectId)],['Статус',x.status],['Дедлайн',dateLabel(x.deadline)],['Дата подання',dateLabel(x.submittedAt)],['Результат',dateLabel(x.resultDate)],['Запит',money(x.requested)],['Загальний бюджет',money(x.totalBudget)],['Власні кошти',money(x.ownFunds)],['Ліміт',money(x.maxAward)],['Номер підтвердження',x.confirmation],['Відповідальний',x.owner],['Джерело',x.officialSource],['Перевірка джерела',x.verification],['Вимоги',x.criteria],['Наступний крок',x.nextStep],['Примітки',x.notes]]:[['Проєкт',projectName(x.projectId)],['Грант',x.grantId?grantName(x.grantId):'Не пов’язаний'],['Дата',dateLabel(x.date)],['Час',`${x.startTime||'—'} — ${x.endTime||'—'}`],['Місце',x.venue],['Адреса',x.address],['Сайт',x.websiteUrl],['Програма',x.programText]];
 return `<div class="facts">${entries.map(([label,val])=>`<div><small>${esc(label)}</small><strong>${/^https?:\/\//.test(String(val||''))?`<a href="${esc(val)}" target="_blank" rel="noopener noreferrer">${esc(val)}</a>`:esc(val||'—')}</strong></div>`).join('')}</div>`;
}
function sublist(type,x,k,meta) {
 const arr=x[k]||[];
 return `<section class="panel subsection"><div class="section-head"><h2>${esc(meta.label)} <span class="count">${arr.length}</span></h2><button class="btn small" data-action="sub-add" data-type="${type}" data-id="${esc(x.id)}" data-sub="${k}">+ Додати</button></div>${arr.length?`<div class="item-list">${arr.map((v,i)=>`<div class="item"><div><strong>${esc(v.title||v.name||v.item||v.label||v.text||v.date||`Запис ${i+1}`)}</strong><small>${esc(meta.fields.map(f=>v[f[0]]).filter(Boolean).slice(1).join(' · '))}</small></div><div class="item-actions"><button class="icon-btn" aria-label="Редагувати" data-action="sub-edit" data-type="${type}" data-id="${esc(x.id)}" data-sub="${k}" data-index="${i}">✎</button><button class="icon-btn danger" aria-label="Видалити" data-action="sub-delete" data-type="${type}" data-id="${esc(x.id)}" data-sub="${k}" data-index="${i}">×</button></div></div>`).join('')}</div>`:'<p class="muted">Поки немає записів.</p>'}</section>`;
}
function attachmentSection(type,x) {
 const arr=x[documentField[type]]||[];
 return `<section class="panel subsection"><div class="section-head"><h2>Файли та версії <span class="count">${arr.length}</span></h2><button class="btn small" data-action="upload" data-type="${type}" data-id="${esc(x.id)}">+ Завантажити</button></div>${arr.map((f,i)=>`<div class="item"><div><strong>${esc(f.filename||f.name||'Файл')}</strong><small>${esc(f.version||'Версія не вказана')} · ${f.stored?(githubMode?'Файл у приватному GitHub':serverMode?'Файл доступний на сервері':'Файл доступний у цьому браузері'):'⚠ Є запис, але оригінал файлу відсутній у відновленій копії'}</small></div><div class="item-actions">${f.stored?`<button class="icon-btn" data-action="download" data-file="${esc(f.id)}" title="Завантажити">↓</button>`:''}<button class="icon-btn danger" data-action="file-delete" data-type="${type}" data-id="${esc(x.id)}" data-index="${i}" title="Видалити">×</button></div></div>`).join('')||'<p class="muted">Немає завантажених документів.</p>'}</section>`;
}
function renderDetail() {
 const x=current();if(!x){selected=null;return renderOverview();}
 const type=selected.type;
 const related=type==='projects'?`<section class="panel subsection"><h2>Пов’язані гранти та концерти</h2>${state.grants.filter(g=>g.projectId===x.id).map(g=>`<button class="overview-row" data-open="grants" data-id="${esc(g.id)}">${esc(g.grantName)} →</button>`).join('')||'<p class="muted">Грантів немає.</p>'}${state.concerts.filter(c=>c.projectId===x.id).map(c=>`<button class="overview-row" data-open="concerts" data-id="${esc(c.id)}">${esc(c.title)} →</button>`).join('')}</section>`:'';
 const history=(x.history||[]).concat(type==='grants'?x.journal||[]:[]);
 return `<button class="back" data-action="back">← ${entityNames[type]}</button><div class="detail-title"><div><div class="eyebrow">${entityNames[type]} · ${esc(x.id)}</div><h1>${esc(titleFor(type,x))}</h1>${pill(x.status)}</div><div class="detail-actions"><button class="btn" data-action="edit" data-type="${type}" data-id="${esc(x.id)}">Редагувати</button><button class="btn danger-outline" data-action="delete" data-type="${type}" data-id="${esc(x.id)}">Видалити</button></div></div>${type==='projects'?`<div class="description">${esc(x.description||'Опис ще не додано.')}</div>`:''}<section class="panel subsection"><h2>Основна інформація</h2>${details(type,x)}</section>${related}${Object.entries(sub[type]).map(([k,v])=>sublist(type,x,k,v)).join('')}${attachmentSection(type,x)}<section class="panel subsection"><h2>Журнал змін</h2>${history.length?history.map(h=>`<p class="activity"><small>${dateLabel(h.date)}</small> ${esc(h.text||h.note||h.title||JSON.stringify(h))}</p>`).join(''):'<p class="muted">Журнал порожній.</p>'}</section>`;
}
function renderCalendar() {
 const [y,m]=month.split('-').map(Number), first=new Date(y,m-1,1), start=(first.getDay()+6)%7, count=new Date(y,m,0).getDate();
 const ev=[...state.grants.filter(g=>g.deadline).map(g=>({date:String(g.deadline).slice(0,10),type:'grants',id:g.id,label:`Грант: ${g.grantName}`})),...state.grants.filter(g=>g.resultDate).map(g=>({date:String(g.resultDate).slice(0,10),type:'grants',id:g.id,label:`Результат: ${g.grantName}`})),...state.concerts.filter(c=>c.date).map(c=>({date:String(c.date).slice(0,10),type:'concerts',id:c.id,label:`Концерт: ${c.title}`}))];
 const cells=[...Array(start).fill(null),...Array.from({length:count},(_,i)=>i+1)];
 return heading('Календар','Дедлайни, результати конкурсів і дати концертів.')+`<section class="panel"><div class="calendar-head"><button class="btn" data-action="month-prev">←</button><h2>${new Intl.DateTimeFormat('uk-UA',{month:'long',year:'numeric'}).format(first)}</h2><button class="btn" data-action="month-next">→</button></div><div class="calendar-grid">${['Пн','Вт','Ср','Чт','Пт','Сб','Нд'].map(d=>`<div class="weekday">${d}</div>`).join('')}${cells.map(d=>{if(!d)return '<div class="day blank"></div>';const iso=`${month}-${String(d).padStart(2,'0')}`;return `<div class="day"><strong>${d}</strong>${ev.filter(e=>e.date===iso).map(e=>`<button data-open="${e.type}" data-id="${esc(e.id)}" title="${esc(e.label)}">${esc(e.label)}</button>`).join('')}</div>`}).join('')}</div></section>`;
}
function renderFiles() {
 const docs=[];for(const type of ['projects','grants','concerts'])for(const x of state[type])for(const f of x[documentField[type]]||[])docs.push({type,entity:x,file:f});
 return heading('Управління файлами',githubMode?'Документи синхронізуються між пристроями через приватний GitHub.':serverMode?'Приватні файли зберігаються в PostgreSQL. JSON-експорт включає доступні вкладення.':'Файли зберігаються лише в поточному браузері. JSON-експорт включає доступні вкладення.')+`<section class="panel"><div class="section-head"><h2>Усі файли <span class="count">${docs.length}</span></h2><button class="btn" data-action="export">Створити резервну копію</button></div>${docs.map(({type,entity,file})=>`<div class="item"><div><strong>${esc(file.filename||file.name)}</strong><small>${esc(titleFor(type,entity))} · ${file.stored?'Доступний':'Оригінал відсутній — завантажте повторно'}</small></div><div class="item-actions">${file.stored?`<button class="icon-btn" data-action="download" data-file="${esc(file.id)}">↓</button>`:''}<button class="btn small" data-open="${type}" data-id="${esc(entity.id)}">Відкрити</button></div></div>`).join('')||'<p class="muted">Немає файлів.</p>'}</section>`;
}
function renderSearch() {
 const q=search.toLocaleLowerCase().trim();
 const all=['projects','grants','concerts'].flatMap(type=>state[type].filter(x=>JSON.stringify(x).toLocaleLowerCase().includes(q)).map(x=>({type,x})));
 return heading('Результати пошуку',`Знайдено ${all.length} записів за запитом «${search}».`)+`<div class="card-grid">${all.map(({type,x})=>`<button class="record-card" data-open="${type}" data-id="${esc(x.id)}"><div class="record-top">${pill(x.status)}<span>${entityNames[type]}</span></div><h2>${esc(titleFor(type,x))}</h2><p>${esc(type==='projects'?x.description:projectName(x.projectId))}</p></button>`).join('')||'<div class="empty">Нічого не знайдено.</div>'}</div>`;
}
function render() {
 const page=selected?renderDetail():search.trim()?renderSearch():tab==='overview'?renderOverview():['projects','grants','concerts'].includes(tab)?renderList(tab):tab==='calendar'?renderCalendar():renderFiles();
 layout((persistPaused?'<div class="notice" role="alert">⚠ Збереження зупинено через помилку або конфлікт GitHub. Не продовжуйте редагування. Експортуйте резервну копію.</div>':'')+page);
}
function formField([key,label,kind='text',required=false],obj={}) {
 const v=obj[key]??'';
 const attr=`name="${esc(key)}" ${required?'required':''}`;
 if(kind==='textarea')return `<label class="form-field"><span>${esc(label)}</span><textarea ${attr} rows="4">${esc(v)}</textarea></label>`;
 if(kind==='project')return `<label class="form-field"><span>${esc(label)}</span><select ${attr}>${projectOptions(v)}</select></label>`;
 if(kind==='grant')return `<label class="form-field"><span>${esc(label)}</span><select ${attr}>${grantOptions(obj.projectId,v)}</select></label>`;
 return `<label class="form-field"><span>${esc(label)}</span><input ${attr} type="${kind}" value="${esc(v)}" ${kind==='number'?'step="any"':''}></label>`;
}
function renderModal() {
 const {mode,type,id,collection,index}=modal;
 const parent=items(type).find(x=>x.id===id), old=mode==='sub'?parent?.[collection]?.[index]||{}:mode==='entity'?parent||{}:{};
 const isSub=mode==='sub';const specs=isSub?sub[type][collection].fields:fields[type];
 const name=isSub?sub[type][collection].label:mode==='entity'?(id?'Редагувати запис':`Створити: ${singular[type]}`):'Дія';
 return `<div class="modal-backdrop" data-action="close-modal"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(name)}"><div class="modal-head"><h2>${esc(name)}</h2><button class="icon-btn" data-action="close-modal" aria-label="Закрити">×</button></div><form id="edit-form"><div class="modal-body">${specs.map(f=>formField(f,old)).join('')}</div><div class="modal-foot"><button type="button" class="btn" data-action="close-modal">Скасувати</button><button class="btn primary" type="submit">Зберегти</button></div></form></div></div>`;
}
function openModal(m) {modal=m;render();$('#edit-form input, #edit-form textarea')?.focus();}
function addEntity(type,data) {
 const x={id:uid(),...data,status:data.status||'Чернетка'};
 if(type==='projects')Object.assign(x,{participants:[],tasks:[],links:[],attachments:[],history:[]});
 if(type==='grants')Object.assign(x,{budget:[],checklist:[],actions:[],journal:[],documents:[],links:[],history:[]});
 if(type==='concerts')Object.assign(x,{performers:[],guests:[],rehearsals:[],tasks:[],expenses:[],links:[],attachments:[],history:[]});
 state[type].push(x);selected={type,id:x.id};tab=type;save(`Створено ${singular[type]}: ${titleFor(type,x)}`,type,x.id);
}
function setFieldValues(target,form) {for(const [k,v] of new FormData(form).entries())target[k]=v;}
function onSaveForm(e) {
 e.preventDefault();const form=e.target;const m=modal;
 if(m.mode==='entity') {
  const x=items(m.type).find(x=>x.id===m.id);
  const values={};setFieldValues(values,form);
  if(m.type==='concerts'&&values.grantId&&state.grants.find(g=>g.id===values.grantId)?.projectId!==values.projectId){alert('Грант має належати до того самого проєкту, що й концерт.');return;}
  if(x){Object.assign(x,values);save(`Оновлено: ${titleFor(m.type,x)}`,m.type,x.id);}else addEntity(m.type,values);
 } else if(m.mode==='sub') {
  const x=items(m.type).find(x=>x.id===m.id);const values={};setFieldValues(values,form);
  if(m.index===-1)x[m.collection].push({id:uid(),...values});else Object.assign(x[m.collection][m.index],values);
  save(`${m.index===-1?'Додано':'Оновлено'} запис «${sub[m.type][m.collection].label}»`,m.type,x.id);
 }
 modal=null;render();
}
function db() {return new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,1);req.onupgradeneeded=()=>req.result.createObjectStore('files');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function blobOp(method,key,value) {
 if(serverMode){
  const path=`/api/files/${encodeURIComponent(key)}`;
  if(method==='get'){const r=await api(path);return await r.blob();}
  if(method==='put'){const r=await api(path,{method:'POST',body:value,headers:{'X-File-Name':encodeURIComponent(value.name||'document.pdf'),'X-File-Type':value.type||'application/octet-stream'}});return r.json();}
  if(method==='delete'){await api(path,{method:'DELETE'});return;}
 }
 if(githubMode) {
  if(method==='get') {
   const f=['projects','grants','concerts'].flatMap(t=>state[t].flatMap(x=>x[documentField[t]]||[])).find(f=>f.id===key);
   return githubClient.downloadFile(key, f?.githubSha, f?.type||'application/octet-stream');
  }
  if(method==='put') return {sha:await githubClient.uploadFile(key,value,value.name||key)};
  if(method==='delete') return githubClient.deleteFile(key);
 }
 const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('files','readwrite'),s=tx.objectStore('files'),req=method==='put'?s.put(value,key):method==='delete'?s.delete(key):s.get(key);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);tx.oncomplete=()=>d.close();});
}
const blobToBase64 = blob => new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.readAsDataURL(blob);});
const base64ToBlob = data => {const [head,b64]=data.split(',');const type=head.match(/data:(.*?);/)?.[1]||'application/octet-stream';const bin=atob(b64);const a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return new Blob([a],{type});};
function download(data,filename,mime='application/json') {const url=URL.createObjectURL(new Blob([data],{type:mime}));const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function exportJSON() {
 if(busy)return;busy=true;
 try {if(serverMode){await persistChain;const r=await api('/api/export');const blob=await r.blob();download(blob,`UYFund_Management_backup_${today()}.json`);return;}if(githubMode)await persistChain;const blobs={};for(const type of ['projects','grants','concerts'])for(const x of state[type])for(const f of x[documentField[type]]||[])if(f.stored){const blob=await blobOp('get',f.id);if(blob)blobs[f.id]=await blobToBase64(blob);}
 const payload={format:'uyfund-management-v2',exportedAt:new Date().toISOString(),state,blobs};download(JSON.stringify(payload,null,2),`UYFund_Management_backup_${today()}.json`);}
 catch(e){alert(`Не вдалося створити резервну копію: ${e.message}`);}finally{busy=false;}
}
async function importJSON(file) {
 if(!file)return;
 try {const data=JSON.parse(await file.text());const next=migrateLegacy(data);
  if(!confirm(`Імпортувати ${next.grants.length} грантів, ${next.projects.length} проєктів і ${next.concerts.length} концертів? Поточні записи в цьому браузері будуть замінені. Перед цим експортуйте резервну копію.`))return;
  if(serverMode){
   await persistChain;
   if(persistPaused)throw new Error('Спочатку усуньте конфлікт збереження');
   const response=await api('/api/import',{method:'POST',body:{state:next,blobs:data.blobs||{},revision:serverRevision}});
   serverRevision=(await response.json()).revision;
   const refreshed=await api('/api/state');state=normalize((await refreshed.json()).state);
   selected=null;tab='overview';statusFilter='';projectFilter='';search='';render();alert('Імпорт на сервер завершено. Перевірте всі записи та вкладення.');return;
  }
  if(githubMode) {
   await persistChain;
   if(persistPaused)throw new Error('Спочатку усуньте конфлікт синхронізації');
   const latestSha=githubClient.stateSha;
   const remote=await githubClient.readState();
   if(githubClient.stateSha!==latestSha){persistPaused=true;throw new Error('Інший пристрій оновив GitHub. Повторіть імпорт після перевірки нових даних.');}
   for(const type of ['projects','grants','concerts'])for(const x of next[type])for(const f of x[documentField[type]]||[]) {
    if(data.blobs?.[f.id]) {
     const original=base64ToBlob(data.blobs[f.id]);
     if(original.size>MAX_FILE_BYTES)throw new Error(`Файл ${f.filename||f.id} перевищує 20 МБ`);
     const result=await githubClient.uploadFile(f.id,original,f.filename||f.name);
     f.githubSha=result;f.stored=true;
    } else {
     const previous=['projects','grants','concerts'].flatMap(t=>(remote[t]||[]).flatMap(x=>x[documentField[t]]||[])).find(a=>a.id===f.id && a.stored);
     f.stored=!!previous;f.githubSha=previous?.githubSha||'';
    }
   }
   await githubClient.saveState(next);
   state=normalize(next);selected=null;tab='overview';statusFilter='';projectFilter='';search='';render();alert('Приватну базу та доступні файли синхронізовано з GitHub. Відкрийте сайт на іншому пристрої для перевірки.');return;
  }
  for(const type of ['projects','grants','concerts'])for(const x of next[type])for(const f of x[documentField[type]]||[])f.stored=!!data.blobs?.[f.id];
  for(const [id,encoded] of Object.entries(data.blobs||{}))await blobOp('put',id,base64ToBlob(encoded));
  state=next;state.activity.unshift({date:new Date().toISOString(),text:`Імпортовано ${file.name}.`});selected=null;tab='overview';statusFilter='';projectFilter='';search='';save();render();alert('Імпорт завершено. Перевірте документи: якщо в JSON були лише посилання, оригінали потрібно завантажити повторно.');
 } catch(e){alert(`Не вдалося імпортувати JSON: ${e.message}`);}
}
function shiftMonth(n) {const [y,m]=month.split('-').map(Number);const d=new Date(y,m-1+n,1);month=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;render();}
async function onClick(e) {
 const el=e.target.closest('[data-action],[data-nav],[data-open]');if(!el)return;
 if(el.dataset.nav){tab=el.dataset.nav;selected=null;statusFilter='';projectFilter='';render();return;}
 if(el.dataset.open){selected={type:el.dataset.open,id:el.dataset.id};tab=el.dataset.open;render();return;}
 const action=el.dataset.action,type=el.dataset.type,id=el.dataset.id;
 if(action==='close-modal'){if(el.classList.contains('modal-backdrop') && e.target!==el)return;modal=null;render();return;}
 if(action==='toggle-menu'){$('.sidebar')?.classList.toggle('shown');return;}
 if(action==='back'){selected=null;render();return;}
 if(action==='create'){openModal({mode:'entity',type,id:null});return;}
 if(action==='edit'){openModal({mode:'entity',type,id});return;}
 if(action==='delete'){
  const x=items(type).find(x=>x.id===id);const linked=type==='projects'?(state.grants.filter(g=>g.projectId===id).length+state.concerts.filter(c=>c.projectId===id).length):type==='grants'?state.concerts.filter(c=>c.grantId===id).length:0;
  if(linked){alert(`Неможливо видалити: запис пов'язаний із ${linked} іншими записами. Спочатку перепризначте їх.`);return;}
  if(confirm(`Видалити «${titleFor(type,x)}»? Цю дію не можна скасувати без резервної копії.`)){state[type]=state[type].filter(v=>v.id!==id);selected=null;save(`Видалено запис: ${titleFor(type,x)}`);render();}return;
 }
 if(action==='sub-add'||action==='sub-edit'){openModal({mode:'sub',type,id,collection:el.dataset.sub,index:action==='sub-add'?-1:Number(el.dataset.index)});return;}
 if(action==='sub-delete') {const x=items(type).find(v=>v.id===id);if(confirm('Видалити цей елемент?')){x[el.dataset.sub].splice(Number(el.dataset.index),1);save('Видалено вкладений запис',type,id);render();}return;}
 if(action==='upload'){window.pendingUpload={type,id};$('#file-input').click();return;}
 if(action==='file-delete'){
  const x=items(type).find(v=>v.id===id),arr=x[documentField[type]],i=Number(el.dataset.index),f=arr[i];
  if(confirm(`Видалити запис про файл «${f.filename||f.name}»? У GitHub попередні версії можуть залишитися в історії комітів.`)){
   arr.splice(i,1);const result=await save(`Видалено файл ${f.filename||f.name}`,type,id);if(persistPaused||result===false)return;
   if(f.stored)try{await blobOp('delete',f.id);}catch(err){alert(`Запис видалено, але файл залишився в GitHub: ${err.message}`);}render();
  }return;
 }
 if(action==='download'){
  try {const blob=await blobOp('get',el.dataset.file);if(!blob){alert('Оригінал цього файлу відсутній.');return;}
   const url=URL.createObjectURL(blob),a=document.createElement('a');const f=['projects','grants','concerts'].flatMap(t=>state[t].flatMap(x=>x[documentField[t]]||[])).find(f=>f.id===el.dataset.file);a.href=url;a.download=f?.filename||'document';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }catch(err){alert(`Не вдалося завантажити документ: ${err.message}`);}return;
 }
 if(action==='export'){await exportJSON();return;}
 if(action==='github-refresh'&&githubMode){
  if(persistPaused){alert('Є незбережені зміни. Спочатку збережіть аварійну копію та розв’яжіть конфлікт.');return;}
  await persistChain;
  if(!confirm('Завантажити найновіші записи з GitHub? Поточні збережені зміни вже синхронізовані.'))return;
  try{state=normalize(await githubClient.readState());selected=null;render();}catch(err){alert(`Не вдалося оновити GitHub: ${err.message}`);}return;
 }
 if(action==='github-disconnect'&&githubMode){
  if(persistPaused){alert('Спочатку збережіть аварійну JSON-копію та розв’яжіть конфлікт.');return;}
  if(!confirm('Від’єднати GitHub на цьому пристрої? Збережені дані залишаться у приватному репозиторії.'))return;
  await persistChain;githubClient?.disconnect();githubClient=null;githubMode=false;state=null;renderGithubLogin();return;
 }
 if(action==='logout'&&serverMode){if(!confirm('Вийти з системи?'))return;await persistChain;await api('/api/logout',{method:'POST'});state=null;csrfToken='';renderLogin();return;}
 if(action==='import'){$('#import-input').click();return;}
 if(action==='month-prev'||action==='month-next'){shiftMonth(action==='month-prev'?-1:1);return;}
}
async function uploadFiles(files) {
 const {type,id}=window.pendingUpload||{};const x=items(type).find(v=>v.id===id);if(!x)return;
 let count=0;
 for(const file of files){
  if(!/\.(pdf|docx?|xlsx?|png|jpe?g|webp|gif)$/i.test(file.name)){alert(`Непідтримуваний тип: ${file.name}`);continue;}
  if(githubMode&&file.size>MAX_FILE_BYTES){alert(`Файл ${file.name} завеликий для GitHub-режиму (максимум 20 МБ).`);continue;}
  const versions=x[documentField[type]].filter(f=>(f.filename||f.name)===file.name).length;
  const fid=uid();
  try {
   const result=await blobOp('put',fid,file);
   x[documentField[type]].push({id:fid,name:file.name,filename:file.name,type:file.type,size:file.size,version:`Версія ${versions+1}`,uploadedAt:new Date().toISOString(),stored:true,githubSha:githubMode?result?.sha:undefined,source:githubMode?'Приватний GitHub':'Завантажено в браузері користувача'});
   count++;
  }catch(err){alert(`Не вдалося завантажити ${file.name}: ${err.message}`);}
 }
 if(count)await save(`Завантажено ${count} файл(ів)`,type,id);render();
}
function renderLogin(message='') {
 $('#app').innerHTML=`<div class="boot login-panel"><h1>UYFund Management System</h1><p>Захищений вхід до системи UYFund.</p>${message?`<p role="alert" class="login-error">${esc(message)}</p>`:''}<form id="login-form"><label class="form-field"><span>Електронна адреса</span><input name="email" type="email" autocomplete="username" required></label><label class="form-field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label><button class="btn primary" type="submit">Увійти</button></form></div>`;
}
function renderGithubLogin(message='') {
 $('#app').innerHTML=`<div class="boot login-panel"><h1>UYFund Management System</h1><p><strong>Приватна синхронізація GitHub</strong></p><p>Усі пристрої працюють з однією базою у приватному репозиторії. Токен не надсилається до ChatGPT і не записується в localStorage.</p>${message?`<p role="alert" class="login-error">${esc(message)}</p>`:''}<form id="github-login-form"><label class="form-field"><span>GitHub fine-grained personal access token</span><input name="token" type="password" autocomplete="off" spellcheck="false" required placeholder="github_pat_…"></label><button class="btn primary" type="submit">Підключитися до приватного GitHub</button></form><p class="muted">Токен: тільки репозиторій <code>zvuk71/uyfund-management</code>, право <strong>Contents: Read and write</strong>. Після оновлення сторінки токен потрібно ввести знову. <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Створити токен у GitHub</a>. Не вставляйте його в чат.</p><p class="muted">Сайт містить лише інтерфейс. Дані й документи не публікуються на GitHub Pages.</p></div>`;
}
async function connectGithub(token) {
 const client=new GitHubStorage(token);
 try {
  await client.checkPrivateAccess();
  const remote=await client.readState();
  baseSeed=normalize(await (await fetch('./data/seed.json',{cache:'no-store'})).json());
  githubClient=client;githubMode=true;persistPaused=false;persistChain=Promise.resolve();
  state=normalize(remote);selected=null;tab='overview';render();
 } catch(err){client.disconnect();renderGithubLogin(err.message);}
}
async function loadServerState() {
 const r=await api('/api/state');const result=await r.json();serverRevision=result.revision;
 state=normalize(result.state);render();
}
async function start() {
 document.addEventListener('click',onClick);
 document.addEventListener('submit',async e=>{
  if(e.target.id==='edit-form')onSaveForm(e);
  if(e.target.id==='github-login-form'){
   e.preventDefault();const token=e.target.elements.token.value.trim();
   $('#app').innerHTML='<div class="boot">Перевіряємо приватний GitHub та завантажуємо базу…</div>';
   await connectGithub(token);
  }
  if(e.target.id==='login-form'){
   e.preventDefault();const form=e.target;const email=form.elements.email.value,password=form.elements.password.value;
   try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({email,password})});const data=await r.json();if(!r.ok)throw new Error(data.error||'Помилка входу');csrfToken=data.csrfToken;baseSeed=normalize(await (await fetch('./data/seed.json',{cache:'no-store'})).json());await loadServerState();}
   catch(err){renderLogin(err.message);}
  }
 });
 document.addEventListener('input',e=>{if(e.target.id==='global-search'){const start=e.target.selectionStart;search=e.target.value;render();const input=$('#global-search');input.focus();input.setSelectionRange(start,start);}});
 document.addEventListener('change',async e=>{
  if(e.target.id==='status-filter'){statusFilter=e.target.value;render();}
  if(e.target.id==='project-filter'){projectFilter=e.target.value;render();}
  if(e.target.id==='import-input'){await importJSON(e.target.files?.[0]);e.target.value='';}
  if(e.target.id==='file-input'){await uploadFiles([...e.target.files]);e.target.value='';}
  if(e.target.name==='projectId'&&modal?.mode==='entity'&&modal.type==='concerts'){$('#edit-form select[name="grantId"]').innerHTML=grantOptions(e.target.value,'');}
 });
 try {
  const modeResponse=await fetch('/api/mode',{cache:'no-store'});
  if(modeResponse.ok && (await modeResponse.json()).mode==='server'){
   serverMode=true;
   const sessionResponse=await fetch('/api/session',{credentials:'same-origin'});
   if(!sessionResponse.ok){renderLogin();return;}
   csrfToken=(await sessionResponse.json()).csrfToken;baseSeed=normalize(await (await fetch('./data/seed.json',{cache:'no-store'})).json());await loadServerState();return;
  }
  if(modeResponse.ok)throw new Error('Невідомий режим сервера');
  // Never silently create a browser-only copy: every static session must connect to GitHub.
  renderGithubLogin();return;
 } catch(e){$('#app').innerHTML=`<div class="boot"><h1>Помилка запуску</h1><p>${esc(e.message)}</p><p>Не очищуйте дані браузера без резервної копії.</p></div>`;}
}
start();