(() => {
  const confirmation = document.getElementById('confirm-start');
  if (confirmation) {
    document.addEventListener('click', event => {
      if (event.target.closest('[data-confirm-start]')) confirmation.showModal();
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
