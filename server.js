function fxPalette(f) {
  if (f.side === "white") {
    return {
      main: "rgba(255,245,220,0.96)",
      accent: "rgba(255,206,84,0.95)",
      soft: "rgba(255,245,220,0.22)"
    };
  }

  return {
    main: "rgba(220,220,230,0.96)",
    accent: "rgba(122,162,255,0.95)",
    soft: "rgba(220,220,230,0.18)"
  };
}

function drawAttackEffect(f) {
  const phase = getAttackPhase(f);
  const piece = renderedPieceKey(f);

  if (phase === "windup") {
    drawWindupEffect(f);
    return;
  }

  if (phase === "recovery") {
    drawRecoveryEffect(f);
    return;
  }

  if (piece === "king") {
    drawKingFX(f);
    return;
  }

  if (piece === "rook") {
    drawRookFX(f);
    return;
  }

  if (piece === "bishop") {
    drawBishopFX(f);
    return;
  }

  if (piece === "knight") {
    drawKnightFX(f);
    return;
  }

  if (piece === "pawn") {
    drawPawnFX(f);
    return;
  }

  if (piece === "queen") {
    drawQueenFX(f);
    return;
  }
}

function drawWindupEffect(f) {
  const p = fxPalette(f);
  const cx = f.x + f.width / 2;
  const cy = f.y + f.height / 2;

  ctx.save();
  ctx.strokeStyle = p.main;
  ctx.lineWidth = 3;

  ctx.beginPath();
  ctx.arc(cx, cy, 30 + Math.sin(Date.now() / 65) * 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = p.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 42 + Math.sin(Date.now() / 80) * 5, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

function drawRecoveryEffect(f) {
  const p = fxPalette(f);
  const box = getAttackBox(f);

  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = p.main;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.restore();
}

function drawStrokeSlash(x1, y1, x2, y2, main, accent, mainWidth = 10, accentWidth = 4) {
  ctx.save();
  ctx.strokeStyle = main;
  ctx.lineWidth = mainWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.lineWidth = accentWidth;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawLane(x, y, w, h, main, accent) {
  ctx.save();
  ctx.fillStyle = main;
  ctx.globalAlpha = 0.28;
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

function drawBurst(cx, cy, rays, innerR, outerR, main, accent) {
  ctx.save();
  ctx.strokeStyle = main;
  ctx.lineWidth = 7;
  for (let i = 0; i < rays; i++) {
    const a = (Math.PI * 2 * i) / rays;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
    ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
    ctx.stroke();
  }

  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawArc(cx, cy, r, start, end, main, accent, mainWidth = 10, accentWidth = 4) {
  ctx.save();
  ctx.strokeStyle = main;
  ctx.lineWidth = mainWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.lineWidth = accentWidth;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 8, start, end);
  ctx.stroke();
  ctx.restore();
}

function drawChevron(x, y, dir, w, h, main, accent) {
  ctx.save();
  ctx.strokeStyle = main;
  ctx.lineWidth = 8;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - dir * w * 0.5, y - h * 0.5);
  ctx.lineTo(x, y);
  ctx.lineTo(x - dir * w * 0.5, y + h * 0.5);
  ctx.stroke();

  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - dir * w * 0.35, y - h * 0.35);
  ctx.lineTo(x, y);
  ctx.lineTo(x - dir * w * 0.35, y + h * 0.35);
  ctx.stroke();
  ctx.restore();
}

function drawKingFX(f) {
  const p = fxPalette(f);
  const dir = f.facing;
  const cx = f.x + f.width / 2;
  const cy = f.y + f.height / 2;

  if (f.attack === "light") {
    drawStrokeSlash(
      cx + dir * 10, cy - 6,
      cx + dir * 62, cy - 12,
      p.main, p.accent, 8, 3
    );
    return;
  }

  if (f.attack === "heavy") {
    drawArc(
      cx + dir * 18,
      cy + 6,
      42,
      dir === 1 ? -1.2 : Math.PI + 0.2,
      dir === 1 ? 1.25 : Math.PI * 2 - 0.2,
      p.main, p.accent, 12, 4
    );
    return;
  }

  if (f.attack === "special" || f.attack === "airSpecial") {
    drawBurst(cx, cy, 8, 18, 60, p.main, p.accent);
    drawArc(cx, cy, 38, 0, Math.PI * 2, p.main, p.accent, 5, 2);
    return;
  }

  if (f.attack === "crouchLight") {
    drawChevron(cx + dir * 32, f.y + f.height * 0.68, dir, 38, 20, p.main, p.accent);
    return;
  }

  if (f.attack === "crouchHeavy") {
    drawStrokeSlash(
      cx + dir * 6, f.y + f.height * 0.58,
      cx + dir * 74, f.y + f.height * 0.42,
      p.main, p.accent, 10, 4
    );
    return;
  }

  if (f.attack === "airLight") {
    drawStrokeSlash(
      cx, cy,
      cx + dir * 56, cy + 10,
      p.main, p.accent, 7, 3
    );
    return;
  }

  if (f.attack === "airHeavy") {
    drawArc(
      cx + dir * 16, cy + 10,
      36,
      dir === 1 ? -1.3 : Math.PI + 0.15,
      dir === 1 ? 1.5 : Math.PI * 2 - 0.15,
      p.main, p.accent, 11, 4
    );
  }
}

function drawRookFX(f) {
  const p = fxPalette(f);
  const dir = f.facing;
  const frontX = dir === 1 ? f.x + f.width : f.x;
  const laneX = dir === 1 ? frontX : frontX - 120;
  const cy = f.y + f.height / 2;

  if (f.attack === "light") {
    drawLane(laneX, cy - 10, 84, 20, p.soft, p.accent);
    return;
  }

  if (f.attack === "heavy") {
    drawLane(dir === 1 ? frontX : frontX - 150, f.y + 18, 150, 40, p.soft, p.accent);
    drawStrokeSlash(
      frontX + dir * 2, cy,
      frontX + dir * 150, cy,
      p.main, p.accent, 9, 3
    );
    return;
  }

  if (f.attack === "special") {
    drawLane(dir === 1 ? frontX : frontX - 210, f.y + 10, 210, 60, p.soft, p.accent);
    drawLane(dir === 1 ? frontX + 170 : frontX - 210, f.y + 18, 36, 44, p.soft, p.main);
    return;
  }

  if (f.attack === "crouchLight") {
    drawLane(dir === 1 ? frontX : frontX - 56, f.y + f.height * 0.64, 56, 12, p.soft, p.accent);
    return;
  }

  if (f.attack === "crouchHeavy") {
    drawLane(dir === 1 ? frontX : frontX - 130, f.y + f.height * 0.55, 130, 20, p.soft, p.accent);
    drawLane(dir === 1 ? frontX + 108 : frontX - 130, f.y + f.height * 0.5, 22, 30, p.soft, p.main);
    return;
  }

  if (f.attack === "airLight") {
    drawLane(dir === 1 ? frontX : frontX - 52, cy + 10, 52, 14, p.soft, p.accent);
    return;
  }

  if (f.attack === "airHeavy" || f.attack === "airSpecial") {
    drawLane(dir === 1 ? frontX : frontX - 110, cy + 2, 110, 24, p.soft, p.accent);
  }
}

function drawBishopFX(f) {
  const p = fxPalette(f);
  const dir = f.facing;
  const cx = f.x + f.width / 2;
  const cy = f.y + f.height / 2;

  if (f.attack === "light") {
    drawStrokeSlash(
      cx - dir * 4, cy + 26,
      cx + dir * 90, cy - 42,
      p.main, p.accent, 8, 3
    );
    return;
  }

  if (f.attack === "heavy") {
    drawStrokeSlash(
      cx - dir * 10, cy - 32,
      cx + dir * 112, cy + 36,
      p.main, p.accent, 10, 4
    );
    return;
  }

  if (f.attack === "special") {
    drawStrokeSlash(
      cx - dir * 18, cy + 56,
      cx + dir * 160, cy - 86,
      p.main, p.accent, 12, 4
    );
    drawStrokeSlash(
      cx - dir * 42, cy + 42,
      cx + dir * 136, cy - 100,
      p.main, p.accent, 5, 2
    );
    return;
  }

  if (f.attack === "airSpecial") {
    drawStrokeSlash(
      cx - dir * 6, cy - 48,
      cx + dir * 146, cy + 84,
      p.main, p.accent, 12, 4
    );
    return;
  }

  if (f.attack === "crouchLight") {
    drawStrokeSlash(
      cx, cy + 18,
      cx + dir * 88, cy - 12,
      p.main, p.accent, 7, 3
    );
    return;
  }

  if (f.attack === "crouchHeavy") {
    drawStrokeSlash(
      cx - dir * 10, cy + 8,
      cx + dir * 104, cy - 30,
      p.main, p.accent, 9, 3
    );
    return;
  }

  if (f.attack === "airLight") {
    drawStrokeSlash(
      cx - dir * 8, cy - 20,
      cx + dir * 70, cy + 24,
      p.main, p.accent, 7, 3
    );
    return;
  }

  if (f.attack === "airHeavy") {
    drawStrokeSlash(
      cx - dir * 12, cy - 28,
      cx + dir * 88, cy + 34,
      p.main, p.accent, 9, 4
    );
  }
}

function drawKnightFX(f) {
  const p = fxPalette(f);
  const dir = f.facing;
  const cx = f.x + f.width / 2;
  const cy = f.y + f.height / 2;

  if (f.attack === "light") {
    drawArc(
      cx + dir * 18,
      cy + 2,
      26,
      dir === 1 ? -1.8 : Math.PI + 0.8,
      dir === 1 ? 0.4 : Math.PI * 2 - 0.8,
      p.main, p.accent, 8, 3
    );
    return;
  }

  if (f.attack === "heavy") {
    drawArc(
      cx + dir * 10,
      cy + 18,
      34,
      dir === 1 ? -1.4 : Math.PI + 0.4,
      dir === 1 ? -0.15 : Math.PI * 2 - 0.4,
      p.main, p.accent, 10, 4
    );
    return;
  }

  if (f.attack === "special") {
    // L-shaped motion graphic
    const x1 = cx - dir * 8;
    const y1 = cy + 16;
    const x2 = cx + dir * 36;
    const y2 = cy - 48;
    const x3 = cx + dir * 88;
    const y3 = cy - 48;

    drawStrokeSlash(x1, y1, x2, y2, p.main, p.accent, 9, 3);
    drawStrokeSlash(x2, y2, x3, y3, p.main, p.accent, 9, 3);
    return;
  }

  if (f.attack === "airSpecial") {
    drawStrokeSlash(
      cx - dir * 12, cy - 38,
      cx + dir * 92, cy + 72,
      p.main, p.accent, 11, 4
    );
    drawArc(
      cx + dir * 18, cy + 12,
      24,
      0,
      Math.PI * 2,
      p.main, p.accent, 4, 2
    );
    return;
  }

  if (f.attack === "crouchLight") {
    drawChevron(cx + dir * 26, cy + 24, dir, 30, 16, p.main, p.accent);
    return;
  }

  if (f.attack === "crouchHeavy") {
    drawStrokeSlash(
      cx - dir * 14, cy + 12,
      cx + dir * 50, cy - 26,
      p.main, p.accent, 8, 3
    );
    return;
  }

  if (f.attack === "airLight") {
    drawArc(
      cx + dir * 4, cy,
      24,
      dir === 1 ? -1.2 : Math.PI + 0.2,
      dir === 1 ? 1.05 : Math.PI * 2 - 0.2,
      p.main, p.accent, 7, 3
    );
    return;
  }

  if (f.attack === "airHeavy") {
    drawChevron(cx + dir * 36, cy + 26, dir, 48, 30, p.main, p.accent);
  }
}

function drawPawnFX(f) {
  const p = fxPalette(f);
  const dir = f.facing;
  const cx = f.x + f.width / 2;
  const cy = f.y + f.height / 2;

  if (f.attack === "light") {
    drawStrokeSlash(
      cx + dir * 2, cy,
      cx + dir * 56, cy,
      p.main, p.accent, 7, 3
    );
    return;
  }

  if (f.attack === "heavy") {
    drawChevron(cx + dir * 42, cy + 2, dir, 48, 28, p.main, p.accent);
    return;
  }

  if (f.attack === "special") {
    drawLane(
      dir === 1 ? cx + 8 : cx - 76,
      cy - 10,
      76,
      20,
      p.soft,
      p.accent
    );
    drawChevron(cx + dir * 62, cy, dir, 36, 20, p.main, p.accent);
    return;
  }

  if (f.attack === "crouchLight") {
    drawStrokeSlash(
      cx + dir * 4, cy + 22,
      cx + dir * 42, cy + 22,
      p.main, p.accent, 6, 2
    );
    return;
  }

  if (f.attack === "crouchHeavy") {
    drawStrokeSlash(
      cx + dir * 10, cy + 26,
      cx + dir * 54, cy - 10,
      p.main, p.accent, 9, 3
    );
    return;
  }

  if (f.attack === "airLight") {
    drawStrokeSlash(
      cx, cy - 6,
      cx + dir * 42, cy + 14,
      p.main, p.accent, 6, 2
    );
    return;
  }

  if (f.attack === "airHeavy") {
    drawChevron(cx + dir * 22, cy + 34, dir, 40, 36, p.main, p.accent);
    return;
  }

  if (f.attack === "airSpecial") {
    drawStrokeSlash(
      cx, cy - 18,
      cx + dir * 56, cy + 48,
      p.main, p.accent, 9, 3
    );
  }
}

function drawQueenFX(f) {
  const p = fxPalette(f);
  const dir = f.facing;
  const cx = f.x + f.width / 2;
  const cy = f.y + f.height / 2;

  if (f.attack === "light") {
    drawStrokeSlash(cx - dir * 8, cy - 18, cx + dir * 82, cy + 18, p.main, p.accent, 9, 3);
    drawStrokeSlash(cx - dir * 8, cy + 18, cx + dir * 82, cy - 18, p.main, p.accent, 5, 2);
    return;
  }

  if (f.attack === "heavy") {
    drawArc(
      cx + dir * 8,
      cy + 4,
      52,
      dir === 1 ? -1.2 : Math.PI + 0.2,
      dir === 1 ? 1.2 : Math.PI * 2 - 0.2,
      p.main, p.accent, 12, 4
    );
    drawStrokeSlash(cx, cy, cx + dir * 122, cy, p.main, p.accent, 5, 2);
    return;
  }

  if (f.attack === "special") {
    drawBurst(cx, cy, 10, 18, 84, p.main, p.accent);
    drawArc(cx, cy, 52, 0, Math.PI * 2, p.main, p.accent, 6, 2);
    return;
  }

  if (f.attack === "airSpecial") {
    drawStrokeSlash(
      cx - dir * 18, cy - 46,
      cx + dir * 102, cy + 70,
      p.main, p.accent, 12, 4
    );
    drawBurst(cx + dir * 40, cy + 16, 6, 10, 38, p.main, p.accent);
    return;
  }

  if (f.attack === "crouchLight") {
    drawStrokeSlash(
      cx + dir * 6, cy + 22,
      cx + dir * 54, cy + 10,
      p.main, p.accent, 7, 3
    );
    return;
  }

  if (f.attack === "crouchHeavy") {
    drawChevron(cx + dir * 52, cy + 10, dir, 60, 32, p.main, p.accent);
    return;
  }

  if (f.attack === "airLight") {
    drawArc(
      cx + dir * 10,
      cy,
      28,
      dir === 1 ? -1.0 : Math.PI,
      dir === 1 ? 1.0 : Math.PI * 2,
      p.main, p.accent, 8, 3
    );
    return;
  }

  if (f.attack === "airHeavy") {
    drawStrokeSlash(
      cx - dir * 10, cy - 20,
      cx + dir * 84, cy + 34,
      p.main, p.accent, 10, 4
    );
  }
}