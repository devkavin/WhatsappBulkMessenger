(() => {
  const page = document.querySelector('[data-status-refresh]');
  if (!page) return;

  let pending = false;
  const interval = setInterval(refresh, 5000);
  document.addEventListener('visibilitychange', refresh);

  async function refresh() {
    if (document.hidden || pending) return;
    pending = true;
    try {
      const response = await fetch(page.dataset.statusRefresh, {
        cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(8000),
      });
      if (response.type === 'opaqueredirect' || response.status === 401) {
        clearInterval(interval);
        document.removeEventListener('visibilitychange', refresh);
        return;
      }
      if (!response.ok) return;
      const snapshot = new DOMParser().parseFromString(await response.text(), 'text/html');
      const regions = new Map([...snapshot.querySelectorAll('[data-status-region]')].map(region => [region.dataset.statusRegion, region]));
      for (const region of page.querySelectorAll('[data-status-region]')) {
        const updated = regions.get(region.dataset.statusRegion);
        if (updated) updateRegion(region, updated);
      }

      const filters = page.querySelector('[data-status-filters]');
      const updatedFilters = snapshot.querySelector('[data-status-filters]');
      if (filters && updatedFilters && filters !== document.activeElement) {
        const labels = new Map([...updatedFilters.options].map(option => [option.value, option.text]));
        for (const option of filters.options) {
          const label = labels.get(option.value);
          if (label && option.text !== label) option.text = label;
        }
      }
    } catch {
      // Retry at the next interval after a timeout or network failure.
    } finally {
      pending = false;
    }
  }

  function updateRegion(region, updated) {
    const focused = document.activeElement;
    if (region.contains(focused) && focused.matches('input, select, textarea, button')) return;

    const openDetails = new Set([...region.querySelectorAll('details[data-status-detail][open]')].map(detail => detail.dataset.statusDetail));
    const focusedDetail = region.contains(focused) && focused.matches('summary') ? focused.parentElement?.dataset.statusDetail : undefined;
    let updatedSummary;
    for (const detail of updated.querySelectorAll('details[data-status-detail]')) {
      if (openDetails.has(detail.dataset.statusDetail)) detail.open = true;
      if (detail.dataset.statusDetail === focusedDetail) updatedSummary = detail.querySelector('summary');
    }
    if (region.isEqualNode(updated)) return;

    const consent = region.querySelector('[name="consent"]');
    const updatedConsent = updated.querySelector('[name="consent"]');
    if (consent && updatedConsent) updatedConsent.checked = consent.checked;

    const table = region.querySelector('.table-wrap');
    const updatedTable = updated.querySelector('.table-wrap');
    const scrollLeft = table?.scrollLeft ?? 0;
    region.replaceWith(updated);
    if (updatedTable) {
      updatedTable.scrollLeft = scrollLeft;
      if (table === focused || (focusedDetail && !updatedSummary)) updatedTable.focus({preventScroll: true});
    }
    updatedSummary?.focus({preventScroll: true});
  }
})();
