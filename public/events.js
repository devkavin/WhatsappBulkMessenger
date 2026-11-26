(() => {
  const create = document.querySelector('#create-event');
  const trigger = document.querySelector('[data-create-event]');
  trigger.addEventListener('click', event => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    create.showModal();
  });

  const initialDialog = document.querySelector('.event-dialog[open]');
  if (initialDialog) {
    initialDialog.removeAttribute('open');
    initialDialog.showModal();
    const page = document.querySelector('.events-workspace');
    if (window.location.pathname === '/events') history.replaceState(history.state, '', page.dataset.statusRefresh);
  }

  for (const cancel of document.querySelectorAll('[data-close-event-dialog]')) {
    cancel.addEventListener('click', event => {
      if (window.location.pathname !== '/events') return;
      event.preventDefault();
      cancel.closest('dialog').close();
    });
  }

  for (const button of document.querySelectorAll('.event-menu-trigger')) {
    const menu = document.getElementById(button.getAttribute('popovertarget'));
    menu.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      const rect = button.getBoundingClientRect();
      const height = document.documentElement.clientHeight;
      const opensAbove = height - rect.bottom < 64;
      menu.style.right = `${document.documentElement.clientWidth - rect.right}px`;
      menu.style.top = opensAbove ? 'auto' : `${rect.bottom + 6}px`;
      menu.style.bottom = opensAbove ? `${height - rect.top + 6}px` : 'auto';
    });
  }
})();
