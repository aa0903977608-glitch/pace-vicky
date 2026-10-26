'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const MAX_BYTES = 5 * 1024 * 1024;
  let reviewMap = null;
  let layer = null;
  let activeRecord = null;

  const setStatus = text => { $('status').textContent = text; };
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const fmtTime = sec => {
    const s = Math.floor(sec || 0);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(r).padStart(2, '0');
  };
  const pinIcon = (kind, label) => L.divIcon({
    className: 'map-pin-wrap map-pin-' + kind,
    html: '<span class="pin-body"><b>' + label + '</b></span>',
    iconSize: [30, 30],
    iconAnchor: [15, 30]
  });

  function validTrack(r) {
    return r && typeof r === 'object' && Array.isArray(r.points) && r.points.length > 0 && r.points.length <= 200000
      && isNum(r.seconds) && isNum(r.meters) && r.seconds >= 0 && r.meters >= 0
      && r.points.every(p => p && isNum(p.lat) && isNum(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180);
  }

  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(x => x !== ''));
  }

  function ensureMap() {
    if (reviewMap) return;
    reviewMap = L.map('reviewMap', { zoomControl: true });
    addBaseMap(reviewMap);
  }

  function showTrack(r) {
    ensureMap();
    if (layer) layer.remove();
    layer = L.layerGroup().addTo(reviewMap);
    const groups = new Map();
    for (const p of r.points) {
      const k = p.segment || 0;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push([p.lat, p.lng]);
    }
    for (const pts of groups.values()) {
      if (pts.length < 2) continue;
      L.polyline(pts, { color: '#fff', weight: 9, opacity: 0.85, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
      L.polyline(pts, { color: '#d95432', weight: 5, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
    }
    const first = r.points[0], last = r.points[r.points.length - 1];
    const bounds = [[first.lat, first.lng]];
    L.marker([first.lat, first.lng], { icon: pinIcon('start', '起'), zIndexOffset: 500 }).bindTooltip('起點').addTo(layer);
    if (r.points.length > 1) {
      L.marker([last.lat, last.lng], { icon: pinIcon('end', '終'), zIndexOffset: 500 }).bindTooltip('終點').addTo(layer);
      bounds.push([last.lat, last.lng]);
    }
    const t = r.target;
    if (t && isNum(t.lat) && isNum(t.lng)) {
      L.marker([t.lat, t.lng], { icon: pinIcon('target', '集'), zIndexOffset: 600 }).bindTooltip('老師指定的集合點').addTo(layer);
      L.polyline([[last.lat, last.lng], [t.lat, t.lng]], { color: '#975325', dashArray: '6 8', weight: 2 }).addTo(layer);
      bounds.push([t.lat, t.lng]);
    }
    $('detail').hidden = false;
    $('list').hidden = true;
    reviewMap.invalidateSize();
    reviewMap.fitBounds(bounds, { padding: [36, 36], maxZoom: 18 });
  }

  function addFact(dl, label, value) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    dl.append(dt, dd);
  }

  function updateStoryCard(r, km, sec, kcal) {
    const date = r.date ? new Date(r.date) : null;
    $('storyDate').textContent = date && !isNaN(date.getTime())
      ? date.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }) + ' · TRAINING JOURNAL'
      : 'TRAINING JOURNAL';
    $('storyDistance').textContent = km.toFixed(2);
    $('storyTime').textContent = fmtTime(sec);
    const pace = r.meters > 0 && sec > 0 ? Math.round(sec / (r.meters / 1000)) : null;
    $('storyPace').textContent = pace == null
      ? '--:-- / km'
      : String(Math.floor(pace / 60)).padStart(2, '0') + ':' + String(pace % 60).padStart(2, '0') + ' / km';
    $('storyKcal').textContent = Math.round(kcal) + ' kcal';
    $('storyType').textContent = r.demo ? '示範運動' : 'GPS 運動紀錄';
  }

  function loadStoryBackground() {
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = new URL('assets/campus-run.webp', document.baseURI).href;
      if (image.complete) resolve(image.naturalWidth ? image : null);
    });
  }

  function roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  async function createStoryImage(r) {
    const width = 1080, height = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('此瀏覽器無法建立分享圖片。');

    ctx.fillStyle = '#17213a';
    ctx.fillRect(0, 0, width, height);
    const image = await loadStoryBackground();
    if (image) {
      const scale = Math.max(width / image.width, height / image.height);
      const imageWidth = image.width * scale, imageHeight = image.height * scale;
      ctx.drawImage(image, (width - imageWidth) / 2, (height - imageHeight) / 2, imageWidth, imageHeight);
    }
    const shade = ctx.createLinearGradient(0, 0, 0, height);
    shade.addColorStop(0, '#101725a8');
    shade.addColorStop(.34, '#10172545');
    shade.addColorStop(.62, '#101725c2');
    shade.addColorStop(1, '#101725f5');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#ffffff50';
    ctx.lineWidth = 2;
    roundedRect(ctx, 48, 48, width - 96, height - 96, 35);
    ctx.stroke();
    const left = 96, right = width - 96;
    for (let i = 0; i < 5; i++) {
      roundedRect(ctx, left + i * 177, 74, 166, 5, 3);
      ctx.fillStyle = '#ffffff9e';
      ctx.fill();
    }

    ctx.fillStyle = '#fff';
    ctx.font = '800 34px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('PACE', left, 145);
    const date = r.date ? new Date(r.date) : null;
    const dateLabel = date && !isNaN(date.getTime())
      ? date.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }) + '  ·  TRAINING JOURNAL'
      : 'TRAINING JOURNAL';
    ctx.font = '500 22px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffffd9';
    ctx.fillText(dateLabel, right, 145, 620);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#ffffffd9';
    ctx.font = '600 25px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('PACE  /  TRAINING JOURNAL', left, 565);
    ctx.fillStyle = '#fff';
    ctx.font = '800 68px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('今天的每一步', left, 660);

    const distanceText = (r.meters / 1000).toFixed(2);
    let distanceFont = 178;
    ctx.font = '500 ' + distanceFont + 'px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    while (ctx.measureText(distanceText).width > 760 && distanceFont > 100) {
      distanceFont -= 8;
      ctx.font = '500 ' + distanceFont + 'px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    }
    const distanceWidth = ctx.measureText(distanceText).width;
    const distanceY = 865;
    ctx.fillStyle = '#fff';
    ctx.fillText(distanceText, left, distanceY);
    ctx.fillStyle = '#ffafc2';
    ctx.font = '800 36px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('KM', left + distanceWidth + 20, distanceY - 8);
    ctx.fillStyle = '#ffffffd9';
    ctx.font = '500 22px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('ONE STEP CLOSER TO YOURSELF.', left + 4, 925);

    const panelX = 96, panelY = 1115, panelWidth = 888, panelHeight = 480;
    roundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 34);
    ctx.fillStyle = '#08101dcc';
    ctx.fill();
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth = 2;
    ctx.stroke();
    const rows = [
      ['運動時間', fmtTime(r.seconds)],
      ['平均配速', $('storyPace').textContent],
      ['估算熱量', $('storyKcal').textContent]
    ];
    rows.forEach(([label, value], index) => {
      const rowY = panelY + 105 + index * 138;
      if (index) {
        ctx.strokeStyle = '#ffffff35';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(panelX + 42, rowY - 47);
        ctx.lineTo(panelX + panelWidth - 42, rowY - 47);
        ctx.stroke();
      }
      ctx.font = '500 25px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#ffffffa8';
      ctx.fillText(label, panelX + 42, rowY);
      ctx.font = '600 34px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'right';
      ctx.fillText(value, panelX + panelWidth - 42, rowY, 500);
      ctx.textAlign = 'left';
    });

    ctx.fillStyle = '#fff';
    ctx.font = '800 27px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('PACE', left, 1745);
    ctx.font = '500 21px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillStyle = '#ffffffc9';
    ctx.fillText(r.demo ? '示範運動紀錄' : '校園 GPS 運動紀錄', left + 130, 1745);
    ctx.fillStyle = '#ffafc2';
    ctx.font = '600 17px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('MOVE WITH INTENTION', right, 1745);
    ctx.textAlign = 'left';

    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('分享圖片輸出失敗。')), 'image/png');
    });
  }

  async function exportStoryCard(r) {
    const button = $('downloadStoryCard');
    button.disabled = true;
    button.textContent = '正在製作分享卡…';
    setStatus('正在製作不含路線座標的分享卡。');
    try {
      const blob = await createStoryImage(r);
      const time = r.date && !isNaN(new Date(r.date).getTime()) ? new Date(r.date).toISOString().slice(0, 10) : 'record';
      const filename = 'pace-story-' + time + '.png';
      const file = typeof File === 'function' ? new File([blob], filename, { type: 'image/png' }) : null;
      if (file && navigator.share && typeof navigator.canShare === 'function') {
        try {
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'PACE 運動分享卡' });
            setStatus('分享卡已送到系統分享選單。');
            return;
          }
        } catch (error) {
          if (error && error.name === 'AbortError') { setStatus('已取消分享。'); return; }
        }
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setStatus('分享卡已下載。');
    } catch (error) {
      setStatus(error && error.message ? error.message : '分享卡製作失敗，請再試一次。');
    } finally {
      button.disabled = false;
      button.textContent = '下載／分享 PNG';
    }
  }

  function showFacts(r) {
    const km = r.meters / 1000, sec = r.seconds;
    const speed = sec > 0 ? km / (sec / 3600) : 0;
    const computedKcal = isNum(r.met) && isNum(r.weight) ? MoveCore.calories(r.met, r.weight, sec) : 0;
    const kcal = isNum(r.kcal) ? r.kcal : computedKcal;
    $('statDistance').textContent = km.toFixed(2);
    $('statTime').textContent = fmtTime(sec);
    $('statSpeed').textContent = speed.toFixed(1);
    $('statKcal').textContent = String(Math.round(kcal));
    updateStoryCard(r, km, sec, kcal);

    const dl = $('facts');
    dl.replaceChildren();
    const pts = r.points;
    const first = pts[0], last = pts[pts.length - 1];
    const segments = new Set(pts.map(p => p.segment || 0)).size;
    const date = r.date ? new Date(r.date) : null;
    addFact(dl, '日期時間', date && !isNaN(date) ? date.toLocaleString('zh-TW') : '未記錄');
    addFact(dl, '紀錄類型', r.demo ? '示範（模擬座標與時間，不代表真實運動）' : 'GPS 真實紀錄');
    addFact(dl, '課堂代號', r.alias || '未填寫');
    addFact(dl, '活動方式', r.mode || '未記錄');
    addFact(dl, '身高 ／ 體重 ／ 年齡', [r.height, r.weight, r.age].map((v, i) => v == null ? '—' : v + ['cm', 'kg', '歲'][i]).join(' ／ '));
    addFact(dl, '活動強度 MET', isNum(r.met) ? String(r.met) : '未記錄');
    addFact(dl, '有效定位點', pts.length + ' 個，分為 ' + segments + ' 段（暫停或斷訊後會另起一段）');
    addFact(dl, '起點座標', first.lat.toFixed(5) + ', ' + first.lng.toFixed(5));
    addFact(dl, '終點座標', last.lat.toFixed(5) + ', ' + last.lng.toFixed(5));
    const t = r.target;
    addFact(dl, '集合點距離', t && isNum(t.lat) && isNum(t.lng)
      ? '終點到集合點直線約 ' + Math.round(MoveCore.distance(last, t)) + ' 公尺'
      : '這次紀錄未設定集合點');
    addFact(dl, '平均速度', speed.toFixed(2) + ' km/h（距離 ÷ 運動時間）');
    addFact(dl, '熱量算式', (isNum(r.met) && isNum(r.weight))
      ? r.met + ' × 3.5 × ' + r.weight + ' ÷ 200 × ' + (sec / 60).toFixed(1) + ' 分鐘 ＝ ' + kcal.toFixed(1) + ' kcal（估算值，非 GPS 測量）'
      : '未記錄');
  }

  function showList(rows, name) {
    activeRecord = null;
    const head = rows[0], body = rows.slice(1);
    const distIdx = head.indexOf('距離 m');
    const kcalIdx = head.indexOf('總熱量 kcal');
    let meters = 0, kcal = 0;
    for (const r of body) {
      meters += Number(r[distIdx]) || 0;
      kcal += Number(r[kcalIdx]) || 0;
    }
    $('listSummary').textContent = name + '：共 ' + body.length + ' 筆，合計距離 ' + (meters / 1000).toFixed(2) + ' km，合計估算熱量 ' + Math.round(kcal) + ' kcal。CSV 只含摘要，沒有路線；要看路線請匯入軌跡 JSON。';
    const thead = $('listHead'), tbody = $('listBody');
    thead.replaceChildren();
    tbody.replaceChildren();
    const htr = document.createElement('tr');
    for (const h of head) { const th = document.createElement('th'); th.textContent = h; htr.append(th); }
    thead.append(htr);
    for (const r of body) {
      const tr = document.createElement('tr');
      for (const v of r) { const td = document.createElement('td'); td.textContent = v; tr.append(td); }
      tbody.append(tr);
    }
    $('list').hidden = false;
    $('detail').hidden = true;
  }

  async function handleFiles(files) {
    const list = [...files];
    if (!list.length) return;
    const f = list[0];
    if (f.size > MAX_BYTES) { setStatus(f.name + ' 超過 5 MB，無法開啟。'); return; }
    const text = (await f.text()).replace(/^﻿/, '');
    if (/\.json$/i.test(f.name) || f.type === 'application/json') {
      let r;
      try { r = JSON.parse(text); } catch { setStatus(f.name + ' 不是有效的 JSON 檔。'); return; }
      if (!validTrack(r)) { setStatus(f.name + ' 不是 PACE 的軌跡 JSON。請用「運動紀錄」的「軌跡」按鈕下載。'); return; }
      activeRecord = r;
      showTrack(r);
      showFacts(r);
      $('detail').hidden = false;
      setStatus('已開啟：' + f.name + (list.length > 1 ? '（一次只開啟第一份檔案）' : ''));
      return;
    }
    const rows = parseCSV(text);
    if (!rows.length || rows[0][0] !== '時間 ISO') { setStatus(f.name + ' 不是 PACE 的摘要 CSV。'); return; }
    showList(rows, f.name);
    setStatus('已開啟：' + f.name);
  }

  $('file').addEventListener('change', e => handleFiles(e.target.files));
  $('downloadStoryCard').addEventListener('click', () => { if (activeRecord) exportStoryCard(activeRecord); });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  document.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
})();
