const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const fileInput = document.getElementById('file-input');

const CLOTH_MARGIN = 6;
const CELL_SIZE = 10;
const KNIFE_WIDTH = 1;
const BAT_RADIUS = 76;
const GRAVITY = 620;
const DAMPING = .988;
const FIXED_STEP = 1 / 60;

let img = null;
let texture = null;
let cutMask = null;
let clothLayer = null;
let points = [];
let constraints = [];
let triangles = [];
let shockwaves = [];
let columns = 0;
let rows = 0;
let currentTool = 'pointer';
let isDown = false;
let draggedPoint = null;
let batInContact = false;
let releaseVelocity = { x: 0, y: 0 };
let lastPos = { x: 0, y: 0, time: 0 };
let lastTexturePos = null;
let cursor = { x: 0, y: 0, visible: false };
let animationFrame = 0;
let lastFrameTime = 0;
let accumulator = 0;
let settledFrames = 0;

document.getElementById('tool-pointer').onclick = () => selectTool('pointer');
document.getElementById('tool-pin').onclick = () => selectTool('pin');
document.getElementById('tool-pin-add').onclick = () => selectTool('pin-add');
document.getElementById('tool-pin-remove').onclick = () => selectTool('pin-remove');
document.getElementById('tool-knife').onclick = () => selectTool('knife');
document.getElementById('tool-bat').onclick = () => selectTool('bat');
document.getElementById('reset').onclick = resetCanvas;
document.getElementById('download').onclick = downloadCanvas;

function selectTool(tool) {
  currentTool = tool;
  canvas.dataset.tool = tool;
  document.querySelectorAll('.tool-button').forEach((button) => {
    button.classList.toggle('selected', button.id === `tool-${tool}`);
  });
  draw();
}

fileInput.addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file || !file.type.startsWith('image/')) return;

  const url = URL.createObjectURL(file);
  const nextImage = new Image();
  nextImage.onload = () => {
    URL.revokeObjectURL(url);
    img = nextImage;
    buildCloth();
  };
  nextImage.onerror = () => URL.revokeObjectURL(url);
  nextImage.src = url;
});

function buildCloth() {
  resizeWorkspace(false);
  const scale = Math.min(
    700 / img.width,
    700 / img.height,
    (canvas.width - 80) / img.width,
    (canvas.height - 130) / img.height,
    1,
  );
  texture = document.createElement('canvas');
  texture.width = Math.ceil(img.width * scale) + CLOTH_MARGIN * 2;
  texture.height = Math.ceil(img.height * scale) + CLOTH_MARGIN * 2;

  const textureCtx = texture.getContext('2d');
  textureCtx.fillStyle = '#fffef9';
  textureCtx.fillRect(0, 0, texture.width, texture.height);
  textureCtx.drawImage(
    img,
    CLOTH_MARGIN,
    CLOTH_MARGIN,
    texture.width - CLOTH_MARGIN * 2,
    texture.height - CLOTH_MARGIN * 2,
  );
  addFabricWeave(textureCtx);
  cutMask = document.createElement('canvas');
  cutMask.width = texture.width;
  cutMask.height = texture.height;

  clothLayer = document.createElement('canvas');
  clothLayer.width = canvas.width;
  clothLayer.height = canvas.height;
  buildMesh();
  ensureAnimation();
}

function addFabricWeave(textureCtx) {
  textureCtx.save();
  textureCtx.globalCompositeOperation = 'soft-light';
  textureCtx.lineWidth = .6;
  for (let y = 1; y < texture.height; y += 3) {
    textureCtx.strokeStyle = y % 6 === 1 ? 'rgba(255,255,255,.2)' : 'rgba(45,35,25,.08)';
    textureCtx.beginPath();
    textureCtx.moveTo(0, y + .5);
    textureCtx.lineTo(texture.width, y + .5);
    textureCtx.stroke();
  }
  for (let x = 1; x < texture.width; x += 3) {
    textureCtx.strokeStyle = x % 6 === 1 ? 'rgba(255,255,255,.12)' : 'rgba(45,35,25,.05)';
    textureCtx.beginPath();
    textureCtx.moveTo(x + .5, 0);
    textureCtx.lineTo(x + .5, texture.height);
    textureCtx.stroke();
  }
  textureCtx.restore();
}

function buildMesh() {
  columns = Math.max(4, Math.ceil(texture.width / CELL_SIZE));
  rows = Math.max(4, Math.ceil(texture.height / CELL_SIZE));
  const left = (canvas.width - texture.width) / 2;
  const top = Math.max(90, (canvas.height - texture.height) / 2 - 20);
  const gather = Math.min(32, texture.width * .07);
  points = [];
  constraints = [];
  triangles = [];
  shockwaves = [];

  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const u = texture.width * column / columns;
      const v = texture.height * row / rows;
      const x = left + gather + u * (texture.width - gather * 2) / texture.width;
      const point = {
        x,
        y: top + v,
        oldX: x - Math.sin(column * 1.7 + row * .8) * 1.8,
        oldY: top + v,
        u,
        v,
        links: [],
        pinned: row === 0 && (column === 0 || column === columns),
      };
      points.push(point);
    }
  }

  const addConstraint = (a, b) => {
    const constraint = { a, b, length: Math.hypot(b.u - a.u, b.v - a.v), cut: false };
    constraints.push(constraint);
    a.links.push(constraint);
    b.links.push(constraint);
  };

  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const point = meshPoint(column, row);
      if (column < columns) addConstraint(point, meshPoint(column + 1, row));
      if (row < rows) addConstraint(point, meshPoint(column, row + 1));
      if (column < columns && row < rows) {
        addConstraint(point, meshPoint(column + 1, row + 1));
        addConstraint(meshPoint(column + 1, row), meshPoint(column, row + 1));
      }
    }
  }

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const topLeft = meshPoint(column, row);
      const topRight = meshPoint(column + 1, row);
      const bottomLeft = meshPoint(column, row + 1);
      const bottomRight = meshPoint(column + 1, row + 1);
      triangles.push({ points: [topLeft, topRight, bottomRight], cutBaseline: null, masked: false });
      triangles.push({ points: [topLeft, bottomRight, bottomLeft], cutBaseline: null, masked: false });
    }
  }

  settledFrames = 0;
  lastFrameTime = 0;
  accumulator = 0;
}

function meshPoint(column, row) {
  return points[row * (columns + 1) + column];
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#d8d2c8';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!texture) return;

  const clothCtx = clothLayer.getContext('2d');
  clothCtx.setTransform(1, 0, 0, 1, 0, 0);
  clothCtx.globalCompositeOperation = 'source-over';
  clothCtx.clearRect(0, 0, clothLayer.width, clothLayer.height);
  triangles.forEach((triangle) => {
    if (triangleIsVisible(triangle)) drawTexturedTriangle(triangle.points, clothCtx);
  });
  clothCtx.globalCompositeOperation = 'destination-out';
  triangles.forEach((triangle) => {
    if (triangle.masked && triangleIsVisible(triangle)) drawTexturedTriangle(triangle.points, clothCtx, cutMask);
  });
  clothCtx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.shadowColor = 'rgba(40, 30, 20, .34)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 9;
  ctx.drawImage(clothLayer, 0, 0);
  ctx.restore();
  drawPins();

  if (cursor.visible && currentTool === 'bat') {
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, BAT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(121, 73, 37, .1)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(94, 53, 24, .65)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function triangleIsVisible(triangle) {
  if (!triangle.cutBaseline) return true;
  return triangle.points.every((point, index, list) => (
    Math.hypot(
      point.x - list[(index + 1) % 3].x,
      point.y - list[(index + 1) % 3].y,
    ) <= triangle.cutBaseline[index] + 1.5
  ));
}

function drawTexturedTriangle([p0, p1, p2], targetCtx, source = texture) {
  const denominator = p0.u * (p1.v - p2.v)
    + p1.u * (p2.v - p0.v)
    + p2.u * (p0.v - p1.v);
  if (!denominator) return;

  const a = (p0.x * (p1.v - p2.v) + p1.x * (p2.v - p0.v) + p2.x * (p0.v - p1.v)) / denominator;
  const b = (p0.y * (p1.v - p2.v) + p1.y * (p2.v - p0.v) + p2.y * (p0.v - p1.v)) / denominator;
  const c = (p0.x * (p2.u - p1.u) + p1.x * (p0.u - p2.u) + p2.x * (p1.u - p0.u)) / denominator;
  const d = (p0.y * (p2.u - p1.u) + p1.y * (p0.u - p2.u) + p2.y * (p1.u - p0.u)) / denominator;
  const e = (
    p0.x * (p1.u * p2.v - p2.u * p1.v)
    + p1.x * (p2.u * p0.v - p0.u * p2.v)
    + p2.x * (p0.u * p1.v - p1.u * p0.v)
  ) / denominator;
  const f = (
    p0.y * (p1.u * p2.v - p2.u * p1.v)
    + p1.y * (p2.u * p0.v - p0.u * p2.v)
    + p2.y * (p0.u * p1.v - p1.u * p0.v)
  ) / denominator;

  const center = { x: (p0.x + p1.x + p2.x) / 3, y: (p0.y + p1.y + p2.y) / 3 };
  const grow = (point) => ({
    x: center.x + (point.x - center.x) * 1.04,
    y: center.y + (point.y - center.y) * 1.04,
  });
  const clipPoints = [p0, p1, p2].map(grow);

  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.moveTo(clipPoints[0].x, clipPoints[0].y);
  targetCtx.lineTo(clipPoints[1].x, clipPoints[1].y);
  targetCtx.lineTo(clipPoints[2].x, clipPoints[2].y);
  targetCtx.closePath();
  targetCtx.clip();
  targetCtx.setTransform(a, b, c, d, e, f);
  targetCtx.drawImage(source, 0, 0);
  targetCtx.restore();
}

function drawPins() {
  points.filter((point) => point.pinned).forEach((point) => {
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#8b8580';
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 3;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.beginPath();
    ctx.arc(point.x - 1.5, point.y - 1.5, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ece9e4';
    ctx.fill();
  });
}

function ensureAnimation() {
  settledFrames = 0;
  if (!animationFrame) animationFrame = requestAnimationFrame(stepPhysics);
}

function stepPhysics(now) {
  animationFrame = 0;
  if (!lastFrameTime) lastFrameTime = now;
  accumulator = Math.min(accumulator + (now - lastFrameTime) / 1000, .05);
  lastFrameTime = now;
  let motion = 0;

  while (accumulator >= FIXED_STEP) {
    motion = simulateCloth();
    accumulator -= FIXED_STEP;
  }
  draw();

  settledFrames = !isDown && motion < .025 ? settledFrames + 1 : 0;
  if (isDown || settledFrames < 35) {
    animationFrame = requestAnimationFrame(stepPhysics);
  } else {
    lastFrameTime = 0;
    accumulator = 0;
  }
}

function simulateCloth() {
  let motion = 0;
  advanceShockwaves();
  points.forEach((point) => {
    if (point.pinned || point === draggedPoint) return;
    const velocityX = (point.x - point.oldX) * DAMPING;
    const velocityY = (point.y - point.oldY) * DAMPING;
    point.oldX = point.x;
    point.oldY = point.y;
    point.x += velocityX;
    point.y += velocityY + GRAVITY * FIXED_STEP ** 2;
    motion += Math.abs(velocityX) + Math.abs(velocityY);
  });

  for (let iteration = 0; iteration < 4; iteration += 1) {
    constraints.forEach(solveConstraint);
    points.forEach(keepInCanvas);
  }
  return motion / Math.max(points.length, 1);
}

function solveConstraint(constraint) {
  if (constraint.cut) return;
  const { a, b, length } = constraint;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy) || 1;
  const correction = (distance - length) / distance;
  const fixedA = a.pinned || a === draggedPoint;
  const fixedB = b.pinned || b === draggedPoint;

  if (!fixedA && !fixedB) {
    a.x += dx * correction * .5;
    a.y += dy * correction * .5;
    b.x -= dx * correction * .5;
    b.y -= dy * correction * .5;
  } else if (!fixedA) {
    a.x += dx * correction;
    a.y += dy * correction;
  } else if (!fixedB) {
    b.x -= dx * correction;
    b.y -= dy * correction;
  }
}

function keepInCanvas(point) {
  if (point.pinned || point === draggedPoint) return;
  point.x = Math.max(4, Math.min(canvas.width - 4, point.x));
  point.y = Math.max(4, Math.min(canvas.height - 4, point.y));
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * canvas.width / rect.width,
    y: (event.clientY - rect.top) * canvas.height / rect.height,
  };
}

canvas.addEventListener('pointerdown', (event) => {
  if (!texture) return;
  const point = canvasPoint(event);
  if (currentTool === 'pin-add' || currentTool === 'pin-remove') {
    const pin = nearestPoint(point, CELL_SIZE * 1.5, currentTool === 'pin-remove');
    if (pin) {
      pin.pinned = currentTool === 'pin-add';
      pin.oldX = pin.x;
      pin.oldY = pin.y;
      ensureAnimation();
      draw();
    }
    return;
  }
  if (currentTool === 'pointer') draggedPoint = nearestPoint(point, CELL_SIZE * 1.25, false);
  else if (currentTool === 'pin') draggedPoint = nearestPoint(point, 30, true);
  else draggedPoint = null;
  isDown = !['pointer', 'pin'].includes(currentTool) || Boolean(draggedPoint);
  if (!isDown) return;

  batInContact = false;
  releaseVelocity = { x: 0, y: 0 };
  lastPos = { ...point, time: performance.now() };
  lastTexturePos = currentTool === 'knife' ? worldToTexture(point) : null;
  canvas.setPointerCapture(event.pointerId);
  ensureAnimation();
});

canvas.addEventListener('pointermove', (event) => {
  if (!texture) return;
  const point = canvasPoint(event);
  cursor = { ...point, visible: true };
  if (!isDown) {
    draw();
    return;
  }

  const now = performance.now();
  const dt = Math.max((now - lastPos.time) / 1000, 1 / 240);
  const velocityX = (point.x - lastPos.x) / dt;
  const velocityY = (point.y - lastPos.y) / dt;

  if ((currentTool === 'pointer' || currentTool === 'pin') && draggedPoint) {
    draggedPoint.x = point.x;
    draggedPoint.y = point.y;
    releaseVelocity = { x: velocityX, y: velocityY };
  } else if (currentTool === 'knife') {
    cutCloth(point);
  } else if (currentTool === 'bat') {
    const contact = points.some((clothPoint) => (
      pointSegmentDistance(clothPoint, lastPos, point) <= BAT_RADIUS
    ));
    if (contact && !batInContact) hitWithBat(lastPos, point, velocityX, velocityY);
    batInContact = points.some((clothPoint) => (
      Math.hypot(clothPoint.x - point.x, clothPoint.y - point.y) <= BAT_RADIUS
    ));
  }

  lastPos = { ...point, time: now };
  ensureAnimation();
  draw();
});

canvas.addEventListener('pointerup', endInteraction);
canvas.addEventListener('pointercancel', endInteraction);
canvas.addEventListener('pointerleave', () => {
  cursor.visible = false;
  if (!isDown) draw();
});

function endInteraction() {
  if (draggedPoint) {
    draggedPoint.oldX = draggedPoint.x - Math.max(-24, Math.min(24, releaseVelocity.x / 60));
    draggedPoint.oldY = draggedPoint.y - Math.max(-24, Math.min(24, releaseVelocity.y / 60));
  }
  draggedPoint = null;
  lastTexturePos = null;
  isDown = false;
  batInContact = false;
  ensureAnimation();
}

function nearestPoint(target, maximumDistance = Infinity, pinnedOnly = false) {
  let nearest = null;
  let shortest = maximumDistance;
  points.forEach((point) => {
    if (point.pinned !== pinnedOnly) return;
    const distance = Math.hypot(point.x - target.x, point.y - target.y);
    if (distance < shortest) {
      nearest = point;
      shortest = distance;
    }
  });
  return nearest;
}

function hitWithBat(from, to, mouseVelocityX, mouseVelocityY) {
  const speed = Math.hypot(mouseVelocityX, mouseVelocityY) || 1;
  const directionX = mouseVelocityX / speed;
  const directionY = mouseVelocityY / speed;
  const impulse = Math.min(140, speed / 12);
  const wave = {
    directionX,
    directionY,
    impulse,
    hit: new Set(),
    frontier: [],
    elapsed: 0,
    generation: 0,
  };
  points.forEach((point) => {
    if (point.pinned) return;
    const distance = pointSegmentDistance(point, from, to);
    if (distance > BAT_RADIUS) return;
    pushPoint(point, wave, .45 + .55 * (1 - distance / BAT_RADIUS));
    wave.frontier.push(point);
  });
  if (wave.frontier.length) shockwaves.push(wave);
  ensureAnimation();
}

function advanceShockwaves() {
  shockwaves.forEach((wave) => {
    wave.elapsed += FIXED_STEP;
    if (wave.elapsed < 1 / 30) return;
    wave.elapsed = 0;
    wave.generation += 1;
    const next = new Set();
    wave.frontier.forEach((point) => {
      point.links.forEach((constraint) => {
        if (constraint.cut) return;
        const neighbor = constraint.a === point ? constraint.b : constraint.a;
        if (!neighbor.pinned && !wave.hit.has(neighbor)) next.add(neighbor);
      });
    });
    wave.frontier = [...next];
    wave.frontier.forEach((point) => {
      pushPoint(point, wave, Math.max(.08, .26 * .94 ** wave.generation));
    });
  });
  shockwaves = shockwaves.filter((wave) => wave.frontier.length);
}

function pushPoint(point, wave, strength) {
  point.oldX -= wave.directionX * wave.impulse * strength;
  point.oldY -= wave.directionY * wave.impulse * strength;
  wave.hit.add(point);
}

function cutCloth(to) {
  const distance = Math.hypot(to.x - lastPos.x, to.y - lastPos.y);
  const sampleCount = Math.max(1, Math.ceil(distance / 2));
  for (let sample = 1; sample <= sampleCount; sample += 1) {
    const ratio = sample / sampleCount;
    const textureTo = worldToTexture({
      x: lastPos.x + (to.x - lastPos.x) * ratio,
      y: lastPos.y + (to.y - lastPos.y) * ratio,
    }, lastTexturePos);
    if (!textureTo) {
      if (lastTexturePos) cutTextureSegment(lastTexturePos, lastTexturePos, CELL_SIZE * 2);
      lastTexturePos = null;
      continue;
    }
    cutTextureSegment(lastTexturePos || textureTo, textureTo, lastTexturePos ? undefined : CELL_SIZE * 2);
    lastTexturePos = textureTo;
  }
}

function cutTextureSegment(from, to, radius = Math.max(KNIFE_WIDTH + .75, CELL_SIZE * .55)) {
  constraints.forEach((constraint) => {
    if (!constraint.cut && segmentsNear(
      from,
      to,
      { x: constraint.a.u, y: constraint.a.v },
      { x: constraint.b.u, y: constraint.b.v },
      radius,
    )) constraint.cut = true;
  });
  triangles.forEach((triangle) => {
    const hasCutEdge = triangle.points.some((point, index, list) => {
      const next = list[(index + 1) % 3];
      return point.links.some(({ a, b, cut }) => cut && (a === next || b === next));
    });
    if (hasCutEdge && !triangle.cutBaseline) triangle.cutBaseline = triangle.points.map((point, index, list) => (
      Math.hypot(point.x - list[(index + 1) % 3].x, point.y - list[(index + 1) % 3].y)
    ));
    const crossed = triangle.points.some((point, index, list) => (
      segmentsNear(
        from,
        to,
        { x: point.u, y: point.v },
        { x: list[(index + 1) % 3].u, y: list[(index + 1) % 3].v },
        KNIFE_WIDTH + .75,
      )
    ));
    if (!crossed
      && !texturePointInTriangle(from, triangle)
      && !texturePointInTriangle(to, triangle)) return;
    triangle.masked = true;
  });
  const maskCtx = cutMask.getContext('2d');
  maskCtx.strokeStyle = '#fff';
  maskCtx.lineWidth = KNIFE_WIDTH;
  maskCtx.lineCap = 'round';
  maskCtx.beginPath();
  maskCtx.moveTo(from.x, from.y);
  maskCtx.lineTo(to.x, to.y);
  maskCtx.stroke();
}

function texturePointInTriangle(target, triangle) {
  const signs = triangle.points.map((point, index, list) => {
    const next = list[(index + 1) % 3];
    return (target.x - next.u) * (point.v - next.v) - (point.u - next.u) * (target.y - next.v);
  });
  return !signs.some((value) => value < 0) || !signs.some((value) => value > 0);
}

function worldToTexture(target, previous = null) {
  let match = null;
  let shortest = Infinity;
  for (const triangle of triangles) {
    if (!triangleIsVisible(triangle)) continue;
    const [a, b, c] = triangle.points;
    const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (Math.abs(denominator) < .001) continue;
    const weightA = ((b.y - c.y) * (target.x - c.x) + (c.x - b.x) * (target.y - c.y)) / denominator;
    const weightB = ((c.y - a.y) * (target.x - c.x) + (a.x - c.x) * (target.y - c.y)) / denominator;
    const weightC = 1 - weightA - weightB;
    if (weightA >= -.01 && weightB >= -.01 && weightC >= -.01) {
      const candidate = {
        x: a.u * weightA + b.u * weightB + c.u * weightC,
        y: a.v * weightA + b.v * weightB + c.v * weightC,
      };
      const distance = previous ? Math.hypot(candidate.x - previous.x, candidate.y - previous.y) : 0;
      if (distance < shortest) {
        match = candidate;
        shortest = distance;
      }
    }
  }
  return match;
}

function pointSegmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y);
  const position = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + dx * position), point.y - (a.y + dy * position));
}

function segmentsNear(a, b, c, d, radius) {
  const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const boxesOverlap = Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) <= Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x))
    && Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) <= Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
  return (boxesOverlap
    && cross(a, b, c) * cross(a, b, d) <= 0
    && cross(c, d, a) * cross(c, d, b) <= 0)
    || Math.min(
      pointSegmentDistance(a, c, d),
      pointSegmentDistance(b, c, d),
      pointSegmentDistance(c, a, b),
      pointSegmentDistance(d, a, b),
    ) <= radius;
}

function resetCanvas() {
  if (img) buildCloth();
}

function resizeWorkspace(moveCloth = true) {
  const width = Math.max(320, Math.floor(window.innerWidth));
  const height = Math.max(320, Math.floor(window.innerHeight));
  const offsetX = (width - canvas.width) / 2;
  const offsetY = (height - canvas.height) / 2;
  canvas.width = width;
  canvas.height = height;
  if (clothLayer) {
    clothLayer.width = width;
    clothLayer.height = height;
  }
  if (moveCloth && points.length) {
    points.forEach((point) => {
      point.x += offsetX;
      point.oldX += offsetX;
      point.y += offsetY;
      point.oldY += offsetY;
    });
    ensureAnimation();
  }
  draw();
}

function downloadCanvas() {
  if (!texture) return;
  const cursorWasVisible = cursor.visible;
  cursor.visible = false;
  draw();
  const link = document.createElement('a');
  link.download = 'cloth.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
  cursor.visible = cursorWasVisible;
  draw();
}

resizeWorkspace(false);
window.addEventListener('resize', () => resizeWorkspace());
selectTool('pointer');

if (new URLSearchParams(location.search).has('test')) {
  console.assert(
    segmentsNear({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }, 0)
      && !segmentsNear({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 8, y: 0 }, { x: 10, y: 0 }, 1),
    '절단 충돌 계산 실패',
  );
}
