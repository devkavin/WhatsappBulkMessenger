for (const field of document.querySelectorAll('input[data-auto-submit]')) {
  field.addEventListener('change', () => {
    if (field.files.length) field.form.requestSubmit();
  });
}

const zone = document.querySelector('[data-bulk-upload]');
if (zone) {
  const picker = zone.querySelector('input[type="file"]');
  const token = zone.querySelector('input[name="_csrf"]').value;
  const feedback = document.querySelector('[data-upload-feedback]');
  const status = feedback.querySelector('[data-upload-status]');
  const progress = feedback.querySelector('[data-upload-progress]');
  const errors = feedback.querySelector('[data-upload-errors]');
  const refresh = feedback.querySelector('[data-refresh]');
  const batchSize = Number(zone.dataset.batchSize);
  const maxFileSize = Number(zone.dataset.maxFileSize);
  let uploading = false;

  picker.addEventListener('change', () => upload(Array.from(picker.files)));
  zone.addEventListener('submit', event => {
    event.preventDefault();
    void upload(Array.from(picker.files));
  });
  zone.addEventListener('dragover', event => {
    event.preventDefault();
    zone.classList.add('is-dragged-over');
  });
  zone.addEventListener('dragleave', event => {
    if (!zone.contains(event.relatedTarget)) zone.classList.remove('is-dragged-over');
  });
  zone.addEventListener('drop', event => {
    event.preventDefault();
    zone.classList.remove('is-dragged-over');
    void upload(Array.from(event.dataTransfer.files));
  });
  refresh.addEventListener('click', () => window.location.reload());

  async function upload(files) {
    if (uploading || !files.length) return;
    uploading = true;
    picker.disabled = true;
    zone.setAttribute('aria-busy', 'true');
    feedback.hidden = false;
    refresh.hidden = true;
    errors.replaceChildren();
    progress.value = 0;
    status.textContent = `Uploading ${files.length} images…`;

    let uploaded = 0;
    let processed = 0;
    const seen = new Set();
    try {
      const accepted = files.filter(file => {
        if (seen.has(file.name)) return report(file.name, 'This filename appears more than once in the selection.');
        seen.add(file.name);
        if (file.size > maxFileSize) return report(file.name, 'Images must be 5 MB or smaller.');
        return true;
      });
      for (let start = 0; start < accepted.length; start += batchSize) {
        const batch = accepted.slice(start, start + batchSize);
        const body = new FormData();
        for (const file of batch) body.append('images', file);
        const response = await fetch(zone.action, {
          method: 'POST',
          headers: { Accept: 'application/json', 'X-CSRF-Token': token },
          body,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw Error(result.error || 'An upload request failed. Refresh matches and try again.');
        uploaded += result.uploaded.length;
        for (const issue of result.errors) report(issue.filename, issue.reason);
        processed += batch.length;
        progress.value = processed / accepted.length * 100;
        status.textContent = `Checked ${processed} of ${accepted.length} images.`;
      }
      if (!errors.children.length) {
        const target = new URL(window.location.href);
        target.searchParams.set('notice', 'images');
        target.searchParams.delete('page');
        target.hash = 'images';
        if (target.href === window.location.href) window.location.reload();
        else window.location.replace(target);
        return;
      }
      status.textContent = `${uploaded} images uploaded. Review the files below.`;
    } catch (error) {
      status.textContent = `${uploaded} images confirmed uploaded. ${error.message}`;
    } finally {
      uploading = false;
      picker.disabled = false;
      picker.value = '';
      zone.removeAttribute('aria-busy');
      refresh.hidden = false;
    }
  }

  function report(filename, reason) {
    const item = document.createElement('li');
    item.textContent = `${filename} — ${reason}`;
    errors.append(item);
    return false;
  }
}
