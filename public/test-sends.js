const testForm = document.querySelector('#send-test');
if (testForm) {
  const ticket = testForm.elements.ticket;
  const upload = testForm.elements.image;
  const message = testForm.querySelector('[data-sample-message]');
  const image = testForm.querySelector('[data-sample-image]');
  let url;

  ticket.addEventListener('input', () => {
    message.textContent = testForm.dataset.template.replace(/\{\{\s*ticket_number\s*\}\}/g, () => ticket.value);
  });
  upload.addEventListener('change', () => {
    if (url) URL.revokeObjectURL(url);
    const file = upload.files[0];
    image.hidden = !file;
    if (!file) { image.removeAttribute('src'); return; }
    url = URL.createObjectURL(file);
    image.src = url;
  });
}
