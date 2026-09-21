const copyButton = document.querySelector('#copy');
copyButton.addEventListener('click', async () => {
  const status = document.querySelector('#copy-result');
  try {
    await navigator.clipboard.writeText(document.querySelector('#install-command').textContent);
    copyButton.textContent = 'Copied';
    status.textContent = 'Install command copied. Paste it into your terminal.';
    setTimeout(() => { copyButton.textContent = 'Copy'; }, 2500);
  } catch {
    status.textContent = 'Select and copy the command above. Your browser blocked clipboard access.';
  }
});
