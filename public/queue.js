(() => {
  const confirmation = document.getElementById('confirm-start');
  if (confirmation) {
    document.addEventListener('click', event => {
      if (event.target.closest('[data-confirm-start]')) confirmation.showModal();
    });
  }

  const selectMissing = document.querySelector('[data-select-missing]');
  if (selectMissing) {
    selectMissing.hidden = false;
    selectMissing.addEventListener('click', () => {
      for (const attempt of selectMissing.form.querySelectorAll('[data-missing-attempt]')) attempt.checked = true;
    });
  }

  function openLinkedInvitation() {
    if (!location.hash.startsWith('#invitation-')) return;
    const invitation = document.getElementById(location.hash.slice(1));
    if (invitation) invitation.open = true;
  }

  openLinkedInvitation();
  window.addEventListener('hashchange', openLinkedInvitation);
})();
