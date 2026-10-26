'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_STORY_IMAGE_BYTES = 10 * 1024 * 1024;
  const defaultStoryBackgroundUrl = new URL('assets/campus-run.webp', document.baseURI).href;
  let reviewMap = null;
  let layer = null;
  let activeRecord = null;
  let storyBackgroundUrl = defaultStoryBackgroundUrl;
  let storyBackgroundObjectUrl = null;
  let storyBackgroundFocus = .68;
  let storyBackgroundLoadToken = 0;

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

  function updateStoryCard(r, km, sec, speed, kcal) {
    const date = r.date ? new Date(r.date) : null;
    $('storyDate').textContent = date && !isNaN(date.getTime())
      ? date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '.')
      : 'PACE / MOVEMENT LOG';
    $('storyDistance').textContent = km.toFixed(2);
    $('storyTime').textContent = fmtTime(sec);
    const pace = r.meters > 0 && sec > 0 ? Math.round(sec / (r.meters / 1000)) : null;
    $('storyPace').textContent = pace == null
      ? '--:-- / km'
      : String(Math.floor(pace / 60)).padStart(2, '0') + ':' + String(pace % 60).padStart(2, '0') + ' / km';
    $('storySpeed').textContent = speed.toFixed(1) + ' km/h';
    $('storyKcal').textContent = Math.round(kcal) + ' kcal';
    $('storyType').textContent = r.demo ? '示範運動' : 'GPS 運動紀錄';
    renderStoryTrack(r);
  }

  function updateStoryTitle() {
    const title = $('storyTitleInput').value.trim() || '今日運動紀錄';
    $('storyTitleDisplay').textContent = title;
  }

  function resetStoryBackground() {
    storyBackgroundLoadToken++;
    if (storyBackgroundObjectUrl) URL.revokeObjectURL(storyBackgroundObjectUrl);
    storyBackgroundObjectUrl = null;
    storyBackgroundUrl = defaultStoryBackgroundUrl;
    storyBackgroundFocus = .68;
    $('storyBackgroundImage').src = storyBackgroundUrl;
    $('storyBackgroundImage').style.objectPosition = '68% center';
    $('storyImageInput').value = '';
    setStatus('已恢復預設背景照片。');
  }

  function chooseStoryBackground(file) {
    if (!file) return;
    if (file.size > MAX_STORY_IMAGE_BYTES) {
      $('storyImageInput').value = '';
      setStatus('照片超過 10 MB，請選擇較小的照片。');
      return;
    }
    const supportedType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
      || (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name));
    if (!supportedType) {
      $('storyImageInput').value = '';
      setStatus('請選擇 JPG、PNG 或 WEBP 格式的照片。');
      return;
    }

    const token = ++storyBackgroundLoadToken;
    const objectUrl = URL.createObjectURL(file);
    const candidate = new Image();
    candidate.onload = () => {
      if (token !== storyBackgroundLoadToken) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      if (storyBackgroundObjectUrl) URL.revokeObjectURL(storyBackgroundObjectUrl);
      storyBackgroundObjectUrl = objectUrl;
      storyBackgroundUrl = objectUrl;
      storyBackgroundFocus = .5;
      $('storyBackgroundImage').src = objectUrl;
      $('storyBackgroundImage').style.objectPosition = '50% center';
      setStatus('背景照片已更新，只會在這台裝置上使用。');
    };
    candidate.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      if (token === storyBackgroundLoadToken) setStatus('無法讀取這張照片，請換一張圖片。');
    };
    candidate.src = objectUrl;
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

  function normalizedTrack(r, width, height, padding = 8) {
    const points = Array.isArray(r.points) ? r.points : [];
    if (!points.length) return { segments: [], start: null, end: null };

    let latitudeTotal = 0, segmentCount = 0, previousKey;
    for (let i = 0; i < points.length; i++) {
      latitudeTotal += points[i].lat;
      const key = points[i].segment ?? 0;
      if (i === 0 || key !== previousKey) segmentCount++;
      previousKey = key;
    }
    const selectedIds = segmentCount <= 24
      ? Array.from({ length: segmentCount }, (_, i) => i)
      : Array.from({ length: 24 }, (_, i) => Math.round(i * (segmentCount - 1) / 23));
    const selected = new Set(selectedIds);
    const ranges = [];
    let segmentIndex = 0, rangeStart = 0, rangeKey = points[0].segment ?? 0;
    for (let i = 1; i < points.length; i++) {
      const key = points[i].segment ?? 0;
      if (key !== rangeKey) {
        if (selected.has(segmentIndex)) ranges.push({ start: rangeStart, count: i - rangeStart });
        segmentIndex++;
        rangeStart = i;
        rangeKey = key;
      }
    }
    if (selected.has(segmentIndex)) ranges.push({ start: rangeStart, count: points.length - rangeStart });

    const cosine = Math.max(.01, Math.cos(latitudeTotal / points.length * Math.PI / 180));
    const pointsPerSegment = Math.max(1, Math.floor(240 / Math.max(1, ranges.length)));
    const sampled = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const range of ranges) {
      const count = Math.min(range.count, pointsPerSegment), segment = [];
      for (let i = 0; i < count; i++) {
        const index = count === 1 ? range.start : range.start + Math.round(i * (range.count - 1) / (count - 1));
        const p = points[index], x = p.lng * cosine, y = -p.lat;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        segment.push({ x, y });
      }
      sampled.push(segment);
    }
    if (!sampled.length) return { segments: [], start: null, end: null };

    const spanX = maxX - minX, spanY = maxY - minY;
    const scale = Math.min((width - padding * 2) / Math.max(spanX, .000001), (height - padding * 2) / Math.max(spanY, .000001));
    const offsetX = (width - spanX * scale) / 2, offsetY = (height - spanY * scale) / 2;
    const segments = sampled.map(segment => segment.map(p => ({
      x: offsetX + (p.x - minX) * scale,
      y: offsetY + (p.y - minY) * scale
    })));
    const lastSegment = segments[segments.length - 1];
    return { segments, start: segments[0][0], end: lastSegment[lastSegment.length - 1] };
  }

  function renderStoryTrack(r) {
    const group = $('storyRoutePaths');
    if (!group) return;
    group.replaceChildren();
    const track = normalizedTrack(r, 300, 190, 8);
    const ns = 'http://www.w3.org/2000/svg';
    for (const segment of track.segments) {
      if (segment.length < 2) continue;
      const values = segment.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
      const outline = document.createElementNS(ns, 'polyline');
      outline.setAttribute('class', 'track-outline');
      outline.setAttribute('points', values);
      group.append(outline);
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('class', 'track-line');
      line.setAttribute('points', values);
      group.append(line);
    }
    if (!track.start || !track.end) return;
    for (const [point, className, radius] of [[track.start, 'track-start', 4.5], [track.end, 'track-end', 5.2]]) {
      const marker = document.createElementNS(ns, 'circle');
      marker.setAttribute('class', className);
      marker.setAttribute('cx', point.x.toFixed(1));
      marker.setAttribute('cy', point.y.toFixed(1));
      marker.setAttribute('r', String(radius));
      group.append(marker);
    }
  }

  function loadStoryBackground() {
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = storyBackgroundUrl;
      if (image.complete) resolve(image.naturalWidth ? image : null);
    });
  }

  async function createStoryImage(r) {
    const width = 1080, height = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('此瀏覽器無法建立分享圖片。');

    const ink = '#fff', muted = '#ffffffc9', blue = '#9ee6d3', coral = '#ff684f';
    ctx.fillStyle = '#111a2b';
    ctx.fillRect(0, 0, width, height);
    const image = await loadStoryBackground();
    if (image) {
      const scale = Math.max(width / image.width, height / image.height);
      const imageWidth = image.width * scale, imageHeight = image.height * scale;
      const focus = storyBackgroundFocus;
      ctx.drawImage(image, (width - imageWidth) * focus, (height - imageHeight) / 2, imageWidth, imageHeight);
    }
    const leftShade = ctx.createLinearGradient(0, 0, width, 0);
    leftShade.addColorStop(0, '#101725d9');
    leftShade.addColorStop(.48, '#10172585');
    leftShade.addColorStop(1, '#10172512');
    ctx.fillStyle = leftShade;
    ctx.fillRect(0, 0, width, height);
    const bottomShade = ctx.createLinearGradient(0, height * .46, 0, height);
    bottomShade.addColorStop(0, '#10172500');
    bottomShade.addColorStop(1, '#101725ed');
    ctx.fillStyle = bottomShade;
    ctx.fillRect(0, 0, width, height);
    const topShade = ctx.createLinearGradient(0, 0, 0, 260);
    topShade.addColorStop(0, '#10172580');
    topShade.addColorStop(1, '#10172500');
    ctx.fillStyle = topShade;
    ctx.fillRect(0, 0, width, 260);
    const left = 96, right = width - 96;
    ctx.strokeStyle = '#ffffff70';
    ctx.lineWidth = 2;
    roundedRect(ctx, 48, 48, width - 96, height - 96, 35);
    ctx.stroke();

    ctx.fillStyle = ink;
    ctx.font = '800 34px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('PACE', left, 142);
    const date = r.date ? new Date(r.date) : null;
    const dateLabel = date && !isNaN(date.getTime())
      ? date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '.')
      : 'PACE';
    roundedRect(ctx, 760, 92, 224, 68, 34);
    ctx.fillStyle = '#1017258c';
    ctx.fill();
    ctx.strokeStyle = '#ffffff75';
    ctx.stroke();
    ctx.font = '700 21px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = ink;
    ctx.fillText(dateLabel, 872, 135, 194);
    ctx.textAlign = 'left';

    ctx.fillStyle = coral;
    ctx.font = '800 23px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('CAMPUS MOVEMENT', left, 375);
    ctx.fillStyle = ink;
    const title = ($('storyTitleInput').value || '').trim() || '今日運動紀錄';
    let titleFont = 78;
    ctx.font = '800 ' + titleFont + 'px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    while (ctx.measureText(title).width > right - left && titleFont > 42) {
      titleFont -= 4;
      ctx.font = '800 ' + titleFont + 'px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    }
    ctx.fillText(title, left, 480);
    ctx.fillStyle = muted;
    ctx.font = '500 27px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('每一步，都是進度。', left, 535);
    ctx.fillStyle = '#ffffffd9';
    ctx.font = '800 20px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('DISTANCE', left, 645);

    const distanceText = (r.meters / 1000).toFixed(2);
    let distanceFont = 178;
    ctx.font = '750 ' + distanceFont + 'px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    while (ctx.measureText(distanceText).width > 760 && distanceFont > 100) {
      distanceFont -= 8;
      ctx.font = '750 ' + distanceFont + 'px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    }
    const distanceWidth = ctx.measureText(distanceText).width;
    const distanceY = 790;
    ctx.fillStyle = ink;
    ctx.fillText(distanceText, left, distanceY);
    ctx.fillStyle = coral;
    ctx.font = '800 34px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('KM', left + distanceWidth + 18, distanceY - 10);

    ctx.fillStyle = muted;
    ctx.font = '700 18px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('跑者實際軌跡', left, 875);
    ctx.fillStyle = blue;
    ctx.beginPath();
    ctx.arc(right - 183, 868, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = muted;
    ctx.font = '600 16px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('起點', right - 168, 874);
    ctx.fillStyle = coral;
    ctx.beginPath();
    ctx.arc(right - 87, 868, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = muted;
    ctx.fillText('終點', right - 72, 874);

    const route = normalizedTrack(r, 888, 370, 10), routeTop = 890;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const segment of route.segments) {
      if (segment.length < 2) continue;
      ctx.beginPath();
      segment.forEach((p, index) => {
        const x = left + p.x, y = routeTop + p.y;
        if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 22;
      ctx.stroke();
      ctx.strokeStyle = coral;
      ctx.lineWidth = 10;
      ctx.stroke();
    }
    if (route.start && route.end) {
      for (const [point, color] of [[route.start, blue], [route.end, coral]]) {
        ctx.beginPath();
        ctx.arc(left + point.x, routeTop + point.y, 15, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(left + point.x, routeTop + point.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    const tiles = [
      ['運動時間', fmtTime(r.seconds)],
      ['平均配速', $('storyPace').textContent],
      ['平均速度', $('storySpeed').textContent],
      ['估算熱量', $('storyKcal').textContent]
    ];
    const tileWidth = 426, tileHeight = 165, gap = 36, tileY = 1300;
    tiles.forEach(([label, value], index) => {
      const x = left + (index % 2) * (tileWidth + gap);
      const y = tileY + Math.floor(index / 2) * (tileHeight + 25);
      roundedRect(ctx, x, y, tileWidth, tileHeight, 24);
      ctx.fillStyle = '#101725c9';
      ctx.fill();
      ctx.strokeStyle = '#ffffff55';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = coral;
      ctx.fillRect(x + 24, y + 27, 8, 34);
      ctx.fillStyle = '#ffffffc9';
      ctx.font = '600 22px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
      ctx.fillText(label, x + 50, y + 52);
      ctx.fillStyle = '#fff';
      ctx.font = '800 31px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
      ctx.fillText(value, x + 25, y + 118, tileWidth - 50);
    });

    ctx.strokeStyle = '#ffffff70';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, 1700);
    ctx.lineTo(right, 1700);
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.font = '800 27px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillText('PACE', left, 1770);
    ctx.font = '500 20px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.fillStyle = muted;
    ctx.fillText(r.demo ? '示範運動紀錄' : '校園 GPS 運動紀錄', left + 130, 1770);
    ctx.fillStyle = coral;
    ctx.font = '700 17px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('MOVE AT YOUR OWN PACE', right, 1770);
    ctx.textAlign = 'left';

    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('分享圖片輸出失敗。')), 'image/png');
    });
  }

  async function exportStoryCard(r) {
    const button = $('downloadStoryCard');
    button.disabled = true;
    button.textContent = '正在製作分享卡…';
    setStatus('正在製作含軌跡圖形的分享卡（不含 GPS 座標）。');
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
    updateStoryCard(r, km, sec, speed, kcal);

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
  $('storyTitleInput').addEventListener('input', updateStoryTitle);
  $('storyImageInput').addEventListener('change', e => chooseStoryBackground(e.target.files[0]));
  $('resetStoryImage').addEventListener('click', resetStoryBackground);
  updateStoryTitle();
  $('downloadStoryCard').addEventListener('click', () => { if (activeRecord) exportStoryCard(activeRecord); });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  document.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
})();
