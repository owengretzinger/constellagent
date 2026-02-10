/* ═══════════════════════════════════════════════════════
   Constellagent Landing — main.js
   Constellation canvas, scroll animations, nav behavior
   ═══════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ─── Constellation Canvas ─── */

  const canvas = document.getElementById('constellation');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  const COLORS = ['#7aa2f7', '#7aa2f7', '#7dcfff', '#7dcfff', '#bb9af7', '#9ece6a'];
  const CONNECTION_DIST = 120;
  const MOUSE_RADIUS = 150;

  let w, h;
  let particles = [];
  let mouseX = null;
  let mouseY = null;
  let animId = null;

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function createParticles() {
    const count = w < 768 ? 40 : 80;
    particles = [];
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.6,
        vy: (Math.random() - 0.5) * 0.6,
        radius: Math.random() * 2 + 1,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        baseAlpha: Math.random() * 0.5 + 0.2,
        alpha: 0,
      });
      particles[i].alpha = particles[i].baseAlpha;
    }
  }

  function drawStatic() {
    ctx.clearRect(0, 0, w, h);

    // Draw connections
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = Math.abs(particles[i].x - particles[j].x);
        const dy = Math.abs(particles[i].y - particles[j].y);
        const dist = dx + dy; // Manhattan
        if (dist < CONNECTION_DIST) {
          const opacity = (1 - dist / CONNECTION_DIST) * 0.15;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = 'rgba(192, 202, 245, ' + opacity + ')';
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }
    }

    // Draw particles
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.baseAlpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function animate() {
    ctx.clearRect(0, 0, w, h);

    // Update particles
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      p.x = Math.max(0, Math.min(w, p.x));
      p.y = Math.max(0, Math.min(h, p.y));

      if (mouseX !== null) {
        const dx = p.x - mouseX;
        const dy = p.y - mouseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MOUSE_RADIUS) {
          p.alpha += (1 - p.alpha) * 0.1;
          p.x -= dx * 0.005;
          p.y -= dy * 0.005;
        } else {
          p.alpha += (p.baseAlpha - p.alpha) * 0.05;
        }
      } else {
        p.alpha += (p.baseAlpha - p.alpha) * 0.05;
      }
    }

    // Batch connections into opacity buckets (3 buckets to reduce draw calls)
    var buckets = [[], [], []];
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = Math.abs(particles[i].x - particles[j].x);
        const dy = Math.abs(particles[i].y - particles[j].y);
        const dist = dx + dy;
        if (dist < CONNECTION_DIST) {
          const t = 1 - dist / CONNECTION_DIST;
          const bucket = t > 0.66 ? 2 : t > 0.33 ? 1 : 0;
          buckets[bucket].push(i, j);
        }
      }
    }

    ctx.lineWidth = 0.5;
    var opacities = [0.03, 0.07, 0.12];
    for (let b = 0; b < 3; b++) {
      var segs = buckets[b];
      if (segs.length === 0) continue;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(192, 202, 245, ' + opacities[b] + ')';
      for (let k = 0; k < segs.length; k += 2) {
        ctx.moveTo(particles[segs[k]].x, particles[segs[k]].y);
        ctx.lineTo(particles[segs[k + 1]].x, particles[segs[k + 1]].y);
      }
      ctx.stroke();
    }

    // Batch particles by color
    var colorGroups = {};
    for (let i = 0; i < particles.length; i++) {
      var p = particles[i];
      var key = p.color;
      if (!colorGroups[key]) colorGroups[key] = [];
      colorGroups[key].push(p);
    }

    for (var color in colorGroups) {
      var group = colorGroups[color];
      ctx.fillStyle = color;
      for (let i = 0; i < group.length; i++) {
        var p = group[i];
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    animId = requestAnimationFrame(animate);
  }

  function initCanvas() {
    resize();
    createParticles();

    if (prefersReducedMotion.matches) {
      drawStatic();
    } else {
      if (animId) cancelAnimationFrame(animId);
      animate();
    }
  }

  // Mouse tracking on canvas
  canvas.addEventListener('mousemove', function (e) {
    const rect = canvas.getBoundingClientRect();
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
  });

  canvas.addEventListener('mouseleave', function () {
    mouseX = null;
    mouseY = null;
  });

  // Resize
  let resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      // Recalculate particle count on big changes
      const targetCount = w < 768 ? 40 : 80;
      if (Math.abs(particles.length - targetCount) > 10) {
        createParticles();
      }
      if (prefersReducedMotion.matches) drawStatic();
    }, 150);
  });

  // Reduced motion change
  prefersReducedMotion.addEventListener('change', function () {
    if (prefersReducedMotion.matches) {
      if (animId) cancelAnimationFrame(animId);
      animId = null;
      drawStatic();
    } else {
      animate();
    }
  });

  initCanvas();

  /* ─── Scroll Animations ─── */

  if (!prefersReducedMotion.matches) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('visible');
          }
        });
      },
      { threshold: 0.1 }
    );

    document.querySelectorAll('.animate-in').forEach(function (el) {
      observer.observe(el);
    });
  }

  /* ─── Scroll-aware Nav ─── */

  const nav = document.getElementById('nav');
  let lastScrollY = 0;
  let ticking = false;

  function updateNav() {
    const scrollY = window.scrollY;

    if (scrollY < 80) {
      nav.classList.remove('nav-hidden');
    } else if (scrollY > lastScrollY) {
      nav.classList.add('nav-hidden');
    } else {
      nav.classList.remove('nav-hidden');
    }

    lastScrollY = scrollY;
    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (!ticking) {
      requestAnimationFrame(updateNav);
      ticking = true;
    }
  }, { passive: true });
})();
