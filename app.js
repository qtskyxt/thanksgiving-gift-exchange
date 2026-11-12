'use strict'

const app = document.querySelector('#app')
const status = document.querySelector('#status')
const dialog = document.querySelector('#dialog')
const dialogBody = document.querySelector('#dialog-body')
const stage = document.querySelector('#stage')
const modes = {
  results_only: '只登记结果，直接揭晓',
  external_draw: '已抽过签，保留竞猜',
  draw: '从抽签开始'
}
const phases = { joining: '报名中', receiving: '登记礼物', guessing: '竞猜评分', revealed: '已揭晓' }
const year = new Date().getFullYear()
const apiBase = window.GIFT_API || location.origin
const params = new URLSearchParams(location.search)
const personal = new URLSearchParams(location.hash.slice(1))
const keyPattern = /^[0-9a-f]{64}$/
const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
let key = localStorage.getItem('gift-account')
if (keyPattern.test(personal.get('key') || '')) {
  key = personal.get('key')
  history.replaceState(null, '', location.pathname + location.search)
}
if (!keyPattern.test(key || '')) key = randomKey()
localStorage.setItem('gift-account', key)
let seasonId = params.get('s') || localStorage.getItem('gift-current:' + key) || ''
let season
let archive = []
let screen = 'season'
let filter = ''
let busy = false
let selectedMembers = null

const escaped = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]))
const option = (id, name, selected) => '<option value="' + escaped(id) + '"' + (id === selected ? ' selected' : '') + '>' + escaped(name) + '</option>'
const selectPeople = (people, selected, label = '请选择') =>
  option('', label, selected) + people.map(person => option(person.id, person.name, selected)).join('')
const photoButton = file => file ? '<button type="button" data-photo="' + escaped(file) + '">查看照片</button>' : ''
const photoInput = '<label>礼物照片（选填）<input type="file" accept="image/jpeg,image/png,image/webp" name="image"></label>'
const draftKey = () => 'gift-ballot:' + key + ':' + seasonId

async function call(op, data) {
  if (!window.GIFT_API && location.hostname.endsWith('.github.io')) {
    throw new Error('网页版尚未连接后端，请联系组织者。')
  }
  const response = await fetch(new URL('/api/exchange', apiBase), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, seasonId, data })
  })
  const result = await response.json()
  if (!result.ok) throw new Error(result.message || '操作失败，请重试')
  return result.data
}

function announce(message = '', error = false) {
  status.textContent = message
  status.className = error ? 'error' : ''
}

async function perform(action) {
  if (busy) return
  busy = true
  announce()
  const controls = [...app.querySelectorAll('button:not([disabled])')]
  controls.forEach(control => { control.disabled = true })
  try {
    await action()
  } catch (error) {
    announce(error.message, true)
  } finally {
    busy = false
    controls.forEach(control => { control.disabled = false })
  }
}

async function refresh() {
  season = seasonId ? await call('get') : null
  if (season?.owner || season?.member) localStorage.setItem('gift-current:' + key, seasonId)
  if (screen === 'archive') archive = await call('history')
  render()
}

function createForm(newYear = false) {
  return `<section><h2>创建${newYear ? '新一期' : '活动'}</h2>
    <form data-op="${newYear ? 'newYear' : 'create'}">
      <label>活动年份<input name="year" type="number" min="1900" max="${year}" value="${year}" required></label>
      <label>活动方式<select name="mode">${Object.entries(modes).map(([id, name]) => option(id, name, newYear ? 'draw' : 'results_only')).join('')}</select></label>
      ${newYear || !window.GIFT_API ? '' : '<label>组织者开场码<input name="organizerKey" type="password" required></label>'}
      <button type="submit">创建活动</button>
    </form></section>`
}

function showLink(title, link, note) {
  dialogBody.replaceChildren()
  const heading = document.createElement('h2')
  heading.textContent = title
  const info = document.createElement('p')
  info.textContent = note
  const input = document.createElement('input')
  input.type = 'text'
  input.readOnly = true
  input.value = link
  input.setAttribute('aria-label', title)
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = '复制链接'
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(link); copy.textContent = '已复制' }
    catch { input.select(); copy.textContent = '请手动复制' }
  }
  dialogBody.append(heading, info, input, copy)
  dialog.showModal()
}

function inviteLink() {
  const url = new URL(location.pathname, location.origin)
  if (seasonId) url.searchParams.set('s', seasonId)
  return url
}

function membership() {
  if (!season.member) return `<section><h2>加入成员组</h2><form data-op="joinGroup">
    <label>昵称<input name="name" maxlength="24" required></label><button type="submit">加入成员组</button>
    </form><p class="muted">本届参加名单由组织者选择。</p></section>`
  return `<details><summary>我的成员资料 · ${escaped(season.myName)}</summary>
    <form data-op="memberProfile"><label>昵称<input name="name" value="${escaped(season.myName)}" maxlength="24" required></label>
    <button type="submit">保存昵称</button></form></details>`
}

function joining() {
  const profile = season.myProfile || {}
  const profileForm = season.member && season.mode === 'draw' ? `<details><summary>本届收件资料</summary>
    <form data-op="profile"><label>收件人、电话和地址<textarea name="address" maxlength="240" required>${escaped(profile.address)}</textarea></label>
    <label>送礼偏好<textarea name="tips" maxlength="400">${escaped(profile.tips)}</textarea></label><button type="submit">保存</button></form></details>` : ''
  if (!season.owner) return profileForm + (season.member ? '<section><p>已加入成员组，等待组织者确定本届名单。</p></section>' : '')
  const candidates = season.candidates || []
  selectedMembers ||= new Set((season.roster || []).map(person => person.id))
  return profileForm + `<section><h2>选择本届参加成员</h2>
    <button type="button" data-action="invite">复制成员组邀请链接</button>
    <form data-op="start">
    <p class="muted">${candidates.length ? '勾选本届参加的人。组织者要参加也需勾选自己。' : '邀请成员加入后，在这里选择参加的人。'}</p>
    ${candidates.map(person => `<label class="member-choice">
      <input type="checkbox" name="roster" value="${escaped(person.id)}"${selectedMembers.has(person.id) ? ' checked' : ''}>
      <span>${escaped(person.name)}${person.id === season.actor ? '（你）' : ''}
      ${season.mode === 'draw' ? (person.profileReady ? ' · 资料已填' : ' · 待填资料') : ''}</span>
    </label>`).join('')}
    <button type="submit"${candidates.length ? '' : ' disabled'}>锁定本届名单并开始</button>
    </form></section>`
}

function targetCard() {
  const target = season.myTarget
  if (season.mode !== 'draw' || !target || season.phase === 'revealed') return ''
  const rows = target.history || []
  return `<section><h2>我的送礼对象 · ${escaped(target.name)}</h2>
    <pre>${escaped(target.address)}</pre><p>${escaped(target.tips)}</p>
    ${rows.length ? '<h3>往年收到的礼物</h3><ul>' + rows.map(row =>
      '<li>' + row.year + ' · ' + escaped(row.name) + ' · ' + escaped(row.senderName) + '送</li>').join('') + '</ul>' : ''}
  </section>`
}

function receiving() {
  const people = season.roster.filter(person => person.id !== season.actor)
  const gift = season.myGift || {}
  const pair = season.mode === 'draw' ? '' : `<form data-op="pair">
    <label>我送给了谁<select name="to" required>${selectPeople(people, season.myTarget?.id)}</select></label>
    <button type="submit">保存送礼对象</button><p class="muted">揭晓前，这条配对仅自己可见。</p>
    ${season.pairConflict ? '<p class="error">有人选择了同一位收礼人，请各自核对送礼对象。</p>' : ''}
    </form>`
  return `<section><h2>登记我的礼物</h2>${pair}
    <form data-op="gift"><label>我收到的礼物<input name="name" maxlength="60" value="${escaped(gift.name)}" required></label>
      <label>备注（选填）<textarea name="note" maxlength="240">${escaped(gift.note)}</textarea></label>
      ${photoInput}${photoButton(gift.photo)}<button type="submit">保存收礼记录</button>
    </form></section>`
}

function ballot() {
  if (season.myBallot?.submitted) return '<section><h2>已经交卷</h2><p>全员交卷后自动揭晓。</p></section>'
  const saved = JSON.parse(localStorage.getItem(draftKey()) || 'null') || season.myBallot?.rows || []
  return `<section><h2>猜送礼人并打分</h2><form data-op="submit">
    ${season.gifts.filter(gift => gift.to !== season.actor).map(gift => {
      const row = saved.find(row => row.to === gift.to) || {}
      const known = gift.to === season.myTarget?.id
      return `<fieldset class="record" data-recipient="${escaped(gift.to)}">
        <h3>${escaped(gift.recipientName)}收到 · ${escaped(gift.name)}</h3>${photoButton(gift.photo)}
        ${known ? '<p class="muted">你送出的礼物，猜测和自评分不计入榜单。</p>' :
        '<label>猜谁送的<select name="guess" required>' + selectPeople(season.roster, row.guess) + '</select></label>'}
        <label>评分<select name="score" required>${option('', '请选择星级')}${[1,2,3,4,5].map(n => option(n, n + ' 星', row.score)).join('')}</select></label>
        <label>短评<textarea name="comment" maxlength="140" required>${escaped(row.comment)}</textarea></label>
      </fieldset>`
    }).join('')}
    <button type="submit">交卷</button>
  </form></section>`
}

function giftList(gifts, showAnswers = false) {
  if (!gifts?.length) return ''
  return `<section><h2>${showAnswers ? '礼物揭晓' : '礼物墙'}</h2>${gifts.map(gift =>
    `<article class="record"><h3>${escaped(gift.name)}</h3>
      <p>${showAnswers ? escaped(gift.senderName) + ' 送给 ' : '收礼人 · '}${escaped(gift.recipientName)}</p>
      <p>${escaped(gift.note)}</p>${photoButton(gift.photo)}
      ${gift.votes?.length ? '<details><summary>查看猜测与评分</summary>' + gift.votes.map(vote =>
      '<p>' + escaped(vote.voterName) + ' · 猜 ' + escaped(vote.guessName) + ' · ' + vote.score + ' 星<br>' +
      escaped(vote.comment) + '</p>').join('') + '</details>' : ''}
    </article>`).join('')}</section>`
}

function leaderboard() {
  if (season.mode === 'results_only') return ''
  const rank = (rows, field, label) => {
    let previous, place
    return rows.sort((a, b) => b[field] - a[field]).map((row, index) => {
      if (row[field] !== previous) place = index + 1
      previous = row[field]
      return '<li>' + place + '. ' + escaped(row.name) + ' · ' + label(row[field]) + '</li>'
    }).join('')
  }
  return `<section><h2>榜单</h2><h3>猜中最多</h3><ul class="rows">${rank(season.results.players.slice(), 'correct', n => n + ' 份')}</ul>
    <h3>礼物评分</h3><ul class="rows">${rank(season.results.gifts.filter(row => row.average != null), 'average', n => n.toFixed(2) + ' 星')}</ul></section>`
}

function archiveView() {
  const people = season.people || []
  return `<section><h2>礼物档案</h2>
    <label>按收礼人筛选<select id="archive-filter">${selectPeople(people, filter, '全部收礼人')}</select></label>
    <div class="table"><table><thead><tr><th>年份</th><th>收礼人</th><th>送礼人</th><th>礼物</th></tr></thead>
    <tbody>${archive.filter(row => !filter || row.to === filter).map(row =>
      '<tr><td>' + row.year + '</td><td>' + escaped(row.recipientName) + '</td><td>' + escaped(row.senderName) +
      '</td><td>' + escaped(row.name) + (row.note ? '<br><small>' + escaped(row.note) + '</small>' : '') +
      photoButton(row.photo) + '</td></tr>').join('')}</tbody></table></div>
    ${archive.length ? '' : '<p class="muted">还没有往年礼物记录。</p>'}
  </section><details><summary>补录往年礼物</summary><form data-op="importGift">
    <label>年份<input name="year" type="number" min="1900" max="${season.year - 1}" value="${season.year - 1}" required></label>
    <label>送礼人<select name="from" required>${selectPeople(people)}</select></label>
    ${season.owner ? '<label>收礼人<select name="to" required>' + selectPeople(people) + '</select></label>' : ''}
    <label>礼物名称<input name="name" maxlength="60" required></label>
    <label>备注（选填）<textarea name="note" maxlength="240"></textarea></label>
    ${photoInput}<button type="submit">保存到档案</button>
  </form></details>${season.owner ? `<details><summary>维护历史成员</summary>
    <form data-op="historicalPerson"><label>历史昵称<input name="name" maxlength="24" required></label><button type="submit">添加历史成员</button></form>
    <form data-op="linkPerson"><label>历史成员<select name="old" required>${selectPeople(people.filter(p => p.historical))}</select></label>
    <label>现有成员<select name="current" required>${selectPeople(people.filter(p => !p.historical))}</select></label><button type="submit">关联为同一人</button></form>
  </details>` : ''}`
}

function render() {
  stage.textContent = season ? season.year + ' · ' + phases[season.phase] + ' · ' + modes[season.mode] : '好友交换礼物'
  if (!season) {
    app.innerHTML = createForm() + '<section><form data-op="open"><label>已有活动？粘贴群邀请链接<input name="invite" type="url" required></label><button type="submit">打开活动</button></form></section>'
    return
  }
  const member = season.owner || season.member
  const tabs = member ? `<nav class="tabs" aria-label="活动导航">
    <button type="button" data-action="season" aria-pressed="${screen === 'season'}">本届活动</button>
    <button type="button" data-action="archive" aria-pressed="${screen === 'archive'}">礼物档案</button>
    <button type="button" data-action="refresh">刷新</button>
  </nav>` : ''
  const years = member ? `<details><summary>年度活动</summary>
    <label>切换年份<select id="switch-year">${season.seasons.map(entry => option(entry.id, entry.year, seasonId)).join('')}</select></label>
    ${season.owner ? createForm(true) : ''}
  </details>` : ''
  let content = ''
  if (screen === 'archive' && member) content = archiveView()
  else if (season.phase === 'joining') content = joining()
  else if (!season.owner && !season.enrolled) content = season.member ? '<section>你没有参加本届活动。</section>' : ''
  else {
    content = targetCard()
    if (season.phase === 'receiving' && season.enrolled) content += receiving()
    if (season.phase === 'guessing' && season.enrolled) content += ballot()
    if (season.phase !== 'revealed') {
      const ready = season.roster.filter(p => season.phase === 'guessing' ? p.ballotReady :
        p.giftReady && (season.mode === 'draw' || p.pairReady)).length
      content += `<section><h2>活动进度</h2><p>${ready} / ${season.roster.length} 人完成</p></section>`
    }
    content += season.results ? leaderboard() + giftList(season.results.gifts, true) : giftList(season.gifts)
  }
  const profile = screen === 'season' ? membership() : ''
  app.innerHTML = tabs + profile + content + years
}

function ballotPayload(form) {
  return Array.from(form.querySelectorAll('[data-recipient]'), field => ({
    to: field.dataset.recipient, guess: field.elements.guess?.value || '',
    score: Number(field.elements.score.value), comment: field.elements.comment.value
  }))
}

async function photoData(file) {
  if (!file?.size) return ''
  const image = new Image()
  const url = URL.createObjectURL(file)
  try {
    image.src = url
    await image.decode()
    const scale = Math.min(1, 960 / Math.max(image.width, image.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.width * scale))
    canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext('2d')
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.68).split(',')[1]
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function switchTo(id) {
  seasonId = id
  screen = 'season'
  filter = ''
  selectedMembers = null
  await refresh()
  history.replaceState(null, '', inviteLink())
}

app.addEventListener('submit', event => {
  event.preventDefault()
  const form = event.target
  const op = form.dataset.op
  if (op === 'submit' && !confirm('确认交卷？提交后答卷将锁定。')) return
  if (op === 'start') {
    const count = form.querySelectorAll('input[name="roster"]:checked').length
    const minimum = season.mode === 'results_only' ? 2 : 3
    if (count < minimum) return announce('本届请至少选择 ' + minimum + ' 位参加成员。', true)
    if (!confirm('确认锁定这 ' + count + ' 位成员并开始活动？')) return
  }
  perform(async () => {
    const data = Object.fromEntries(new FormData(form))
    if (op === 'start') data.roster = new FormData(form).getAll('roster')
    if (op === 'open') {
      const id = new URL(data.invite).searchParams.get('s')
      if (!id || !/^[0-9a-f]{32}$/.test(id)) throw new Error('请粘贴完整的群邀请链接')
      return switchTo(id)
    }
    if (data.year) data.year = Number(data.year)
    if (data.image) {
      const base64 = await photoData(data.image)
      delete data.image
      data.photo = base64 ? (await call('upload', { base64 })).file :
        (op === 'gift' ? season.myGift?.photo || '' : '')
    }
    if (op === 'importGift' && !season.owner) data.to = season.actor
    if (op === 'submit') data.rows = ballotPayload(form)
    const result = await call(op, data)
    if (op === 'submit') localStorage.removeItem(draftKey())
    if (result.seasonId) await switchTo(result.seasonId)
    else await refresh()
    announce('已保存')
  })
})
app.addEventListener('input', event => {
  const form = event.target.closest('form[data-op="submit"]')
  if (form) localStorage.setItem(draftKey(), JSON.stringify(ballotPayload(form)))
})
app.addEventListener('change', event => {
  if (event.target.name === 'roster') {
    if (event.target.checked) selectedMembers.add(event.target.value)
    else selectedMembers.delete(event.target.value)
  }
  if (event.target.id === 'switch-year') perform(() => switchTo(event.target.value))
  if (event.target.id === 'archive-filter') { filter = event.target.value; render() }
})
app.addEventListener('click', event => {
  const button = event.target.closest('button')
  if (!button) return
  if (button.dataset.photo) return perform(async () => {
    const { url } = await call('photo', { file: button.dataset.photo })
    const image = document.createElement('img')
    image.alt = '礼物照片'
    image.src = new URL(url, apiBase).href
    dialogBody.replaceChildren(image)
    dialog.showModal()
  })
  const action = button.dataset.action
  if (action === 'invite') showLink('群邀请链接', inviteLink().href, '好友可以用这个链接加入成员组。本届参加名单由组织者选择。')
  if (action === 'refresh') perform(refresh)
  if (action === 'season' || action === 'archive') perform(async () => { screen = action; await refresh() })
})
document.querySelector('#identity').onclick = () => {
  const url = inviteLink()
  url.hash = 'key=' + key
  showLink('个人登录链接', url.href, '换手机或浏览器时用这个链接恢复身份。请私下保存，持有链接的人可用你的身份操作。')
}

render()
if (seasonId) perform(refresh)
