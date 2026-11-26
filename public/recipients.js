const recipientList = document.querySelector('[data-recipient-list]');
if (recipientList) initializeRecipients(recipientList);

const messageEditor = document.querySelector('#message-editor');
if (messageEditor) initializeMessageEditor(messageEditor);

function initializeMessageEditor(editor) {
  const field = editor.querySelector('#template');
  const preview = editor.querySelector('[data-message-preview]');
  const insertTicket = editor.querySelector('[data-insert-ticket]');

  function updatePreview() {
    const message = field.value.trim().replace(/\{\{\s*ticket_number\s*\}\}/g, () => preview.dataset.ticketNumber);
    preview.textContent = message || 'Your message will appear here.';
  }

  insertTicket.hidden = false;
  field.addEventListener('input', updatePreview);
  insertTicket.addEventListener('click', () => {
    field.setRangeText('{{ticket_number}}', field.selectionStart, field.selectionEnd, 'end');
    field.focus();
    updatePreview();
  });
  updatePreview();
}

function initializeRecipients(workspace) {
  const rows = Array.from(workspace.querySelectorAll('[data-recipient]'), element => {
    const trigger = element.querySelector('[data-preview]');
    return {
      element,
      key: element.dataset.key,
      status: element.dataset.status,
      search: element.dataset.search.toLocaleLowerCase(),
      digits: element.dataset.phone.replace(/\D/g, ''),
      checkbox: element.querySelector('input[name="ticket"]'),
      trigger,
      preview: trigger && document.getElementById(trigger.getAttribute('aria-controls')),
    };
  });
  if (!rows.length) return;
  const form = workspace.querySelector('#stage-form');

  const baseStorageKey = 'dinnerdance:recipient-deselections';
  const eventId = workspace.dataset.eventId;
  const storageKey = eventId && eventId !== '1' ? `${baseStorageKey}:${eventId}` : baseStorageKey;
  const keys = new Set(rows.map(row => row.key));
  const deselected = new Set(readDeselections().filter(key => keys.has(key)));
  const filters = [...workspace.querySelectorAll('[data-filter]')];
  const search = workspace.querySelector('[data-recipient-search]');
  const master = workspace.querySelector('[data-select-view]');
  const pagination = workspace.querySelector('[data-review-pages]');
  const sizeControl = pagination.querySelector('[data-page-size]');
  const previous = pagination.querySelector('[data-previous]');
  const next = pagination.querySelector('[data-next]');
  const label = pagination.querySelector('[data-page-label]');
  const noResults = workspace.querySelector('[data-no-recipients]');
  const selectedCount = workspace.querySelector('[data-selected-count]');
  const stage = workspace.querySelector('[data-stage]');
  let filter = 'all';
  let page = 1;
  let expanded = null;
  let filtered = rows;

  workspace.querySelector('[data-review-tools]').hidden = false;
  master.hidden = false;
  for (const row of rows) {
    if (row.checkbox) {
      row.checkbox.checked = !deselected.has(row.key);
      row.checkbox.addEventListener('change', () => {
        rememberSelection(row);
        saveDeselections();
        updateSelection();
      });
    }
    if (row.trigger) {
      row.trigger.hidden = false;
      row.trigger.addEventListener('click', () => {
        expanded = expanded === row ? null : row;
        render();
      });
    }
  }
  for (const button of filters) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      page = 1;
      for (const item of filters) item.setAttribute('aria-pressed', String(item === button));
      render();
    });
  }
  search.addEventListener('input', () => { page = 1; render(); });
  sizeControl.addEventListener('change', () => { page = 1; render(); });
  previous.addEventListener('click', () => { page--; render(); });
  next.addEventListener('click', () => { page++; render(); });
  form.addEventListener('formdata', event => {
    const bytes = new Uint8Array(Math.ceil(Number(form.dataset.candidateCount) / 8));
    for (const row of rows) {
      if (!row.checkbox?.checked) continue;
      const index = Number(row.checkbox.dataset.candidateIndex);
      bytes[index >> 3] |= 1 << (index % 8);
    }
    const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
    const bitmap = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    event.formData.delete('ticket');
    event.formData.set('selection', bitmap);
  });
  master.addEventListener('change', () => {
    for (const row of filtered) {
      if (!row.checkbox) continue;
      row.checkbox.checked = master.checked;
      rememberSelection(row);
    }
    saveDeselections();
    updateSelection();
  });
  saveDeselections();
  render();

  function render() {
    const needle = search.value.trim().toLocaleLowerCase();
    const phoneSearch = /^[\d+(). -]+$/.test(needle) ? needle.replace(/\D/g, '') : '';
    filtered = rows.filter(row => (filter === 'all' || row.status === filter) &&
      (row.search.includes(needle) || (phoneSearch && row.digits.includes(phoneSearch))));
    const pageSize = Number(sizeControl.value);
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.max(1, Math.min(page, pages));
    const offset = (page - 1) * pageSize;
    const visible = new Set(filtered.slice(offset, offset + pageSize));
    if (!visible.has(expanded)) expanded = null;
    for (const row of rows) {
      row.element.hidden = !visible.has(row);
      if (!row.preview) continue;
      const open = row === expanded;
      row.preview.hidden = !open;
      if (open) {
        const image = row.preview.querySelector('img[data-src]');
        if (image) {
          image.src = image.dataset.src;
          delete image.dataset.src;
        }
      }
      row.trigger.setAttribute('aria-expanded', String(open));
      row.trigger.textContent = open ? 'Hide preview' : 'Preview';
    }
    noResults.hidden = filtered.length > 0;
    pagination.hidden = filtered.length === 0;
    label.textContent = `${offset + 1}–${offset + visible.size} of ${filtered.length}`;
    previous.disabled = page <= 1;
    next.disabled = page >= pages;
    updateSelection();
  }

  function updateSelection() {
    const boxes = filtered.flatMap(row => row.checkbox ? [row.checkbox] : []);
    const count = boxes.filter(box => box.checked).length;
    master.disabled = !boxes.length;
    master.checked = boxes.length > 0 && count === boxes.length;
    master.indeterminate = count > 0 && count < boxes.length;
    const selected = rows.filter(row => row.checkbox?.checked).length;
    selectedCount.textContent = `${selected} ${selected === 1 ? 'recipient' : 'recipients'} selected`;
    stage.disabled = selected === 0;
    stage.textContent = selected ? `Add ${selected} to queue` : 'Add to queue';
  }

  function rememberSelection(row) {
    if (row.checkbox.checked) deselected.delete(row.key);
    else deselected.add(row.key);
  }

  function readDeselections() {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  }

  function saveDeselections() {
    try { localStorage.setItem(storageKey, JSON.stringify([...deselected])); } catch { /* The current page retains its selection. */ }
  }
}
