// ui.js — DOM rendering helpers. All model-provided text is inserted via
// textContent (never innerHTML) so a hostile/odd model response can't inject markup.

// Tiny element builder. attrs may include: class, text, html (trusted only),
// plus any DOM property or data-* / aria-* attribute.
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only used with app-controlled strings
    else if (k === 'onclick') node.addEventListener('click', v);
    else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role') node.setAttribute(k, v);
    else node[k] = v;
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

// Confidence → honest wording, per the design spec.
export function confidenceWord(c) {
  if (c > 0.75) return 'confident';
  if (c >= 0.5) return 'likely';
  return 'best guess';
}

// A sediment-layer style confidence fill (the signature element). 0..1 → %.
function confidenceBar(c) {
  const pct = Math.round(Math.max(0, Math.min(1, c)) * 100);
  const fill = el('span', { class: 'conf-fill' });
  fill.style.width = `${pct}%`;
  const bar = el('span', { class: 'conf-bar', role: 'img', 'aria-label': `confidence ${pct} percent` }, [fill]);
  const label = el('span', { class: 'conf-label', text: `${pct}% · ${confidenceWord(c)}` });
  return el('div', { class: 'conf' }, [bar, label]);
}

const TYPE_LABEL = {
  igneous: 'Igneous',
  sedimentary: 'Sedimentary',
  metamorphic: 'Metamorphic',
  mineral: 'Mineral',
};

// Render the candidate cards (field-guide specimen entries).
export function renderCandidates(container, data) {
  clear(container);

  if (data.image_quality_feedback) {
    container.append(el('p', { class: 'quality-note', text: `📷 ${data.image_quality_feedback}` }));
  }

  const list = el('div', { class: 'cards' });
  data.candidates.forEach((c, i) => {
    const badge = el('span', { class: `badge badge-${c.type}`, text: TYPE_LABEL[c.type] || c.type });
    const header = el('div', { class: 'card-head' }, [
      el('span', { class: 'card-rank', text: `${i + 1}` }),
      el('h3', { class: 'card-name', text: c.name }),
      badge,
    ]);
    const card = el('article', { class: 'card' }, [
      header,
      confidenceBar(c.confidence),
      el('p', { class: 'evidence', text: c.visual_evidence }),
      c.commonly_confused_with?.length
        ? el('p', { class: 'confused', text: `Easily confused with: ${c.commonly_confused_with.join(', ')}` })
        : null,
    ]);
    list.append(card);
  });
  container.append(list);
}

// Render a single diagnostic question with big answer buttons.
// onAnswer(answerString) is called when a button is tapped.
export function renderQuestion(container, { question, index, total, onAnswer }) {
  clear(container);

  container.append(el('p', { class: 'q-progress', text: `Test ${index + 1} of ${total}` }));
  container.append(el('h2', { class: 'q-text', text: question.text }));
  container.append(el('p', { class: 'q-howto', text: question.how_to }));

  const btns = el('div', { class: 'answers' });
  question.answers.forEach((ans) => {
    const isCant = /can'?t test/i.test(ans);
    btns.append(
      el('button', {
        class: `answer-btn${isCant ? ' answer-cant' : ''}`,
        type: 'button',
        text: ans,
        onclick: () => onAnswer(ans),
      })
    );
  });
  container.append(btns);

  if (question.discriminates) {
    const det = el('details', { class: 'q-why' }, [
      el('summary', { text: 'Why this test?' }),
      el('p', { text: question.discriminates }),
    ]);
    container.append(det);
  }
}

// Render the final verdict, honestly.
export function renderVerdict(container, v) {
  clear(container);
  const word = confidenceWord(v.final.confidence);

  container.append(
    el('div', { class: 'verdict-head' }, [
      el('p', { class: 'verdict-kicker', text: word.toUpperCase() }),
      el('h2', { class: 'verdict-name', text: v.final.name }),
      confidenceBar(v.final.confidence),
    ])
  );

  container.append(el('p', { class: 'verdict-reasoning', text: v.final.reasoning }));

  container.append(
    el('div', { class: 'panel panel-runner' }, [
      el('h3', { text: `Runner-up: ${v.runner_up.name}` }),
      el('p', { text: v.runner_up.why_still_possible }),
    ])
  );

  container.append(
    el('div', { class: 'panel panel-confirm' }, [
      el('h3', { text: 'Confirm it yourself' }),
      el('p', { text: v.confirm_with }),
    ])
  );

  container.append(
    el('div', { class: 'panel panel-caveat' }, [
      el('h3', { text: 'Honest caveats' }),
      el('p', { text: v.caveats }),
    ])
  );
}

// A collapsible raw-response debug block (used on parse failures).
export function renderRawDebug(container, rawText) {
  const det = el('details', { class: 'raw-debug' }, [
    el('summary', { text: 'Show raw model response' }),
    el('pre', { text: rawText || '(empty)' }),
  ]);
  container.append(det);
}

// Toast-ish inline status line. kind: 'ok' | 'err' | 'info'.
export function statusLine(text, kind = 'info') {
  return el('p', { class: `status status-${kind}`, text });
}
