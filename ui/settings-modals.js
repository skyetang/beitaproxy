(() => {
  let modalCallback = null;
  let confirmCallback = null;
  let confirmCancelCallback = null;
  let choiceCallback = null;

  window.showModal = function showModal(title, desc, placeholder, inputType, btnText, callback) {
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalDesc').textContent = desc;
    document.getElementById('modalInput').placeholder = placeholder;
    document.getElementById('modalInput').type = inputType;
    document.getElementById('modalInput').value = '';
    document.getElementById('modalSubmitBtn').textContent = btnText;
    document.getElementById('inputModal').classList.remove('hidden');
    document.getElementById('modalInput').focus();
    modalCallback = callback;
  };

  window.closeModal = function closeModal() {
    document.getElementById('inputModal').classList.add('hidden');
    document.getElementById('modalSubmitBtn').textContent = t('static.continue');
    modalCallback = null;
  };

  window.submitModal = function submitModal() {
    const value = document.getElementById('modalInput').value;
    const callback = modalCallback;
    closeModal();
    if (callback) callback(value);
  };

  window.showAlert = function showAlert(title, message) {
    document.getElementById('alertTitle').textContent = title;
    document.getElementById('alertMsg').textContent = message;
    document.getElementById('alertModal').classList.remove('hidden');
  };

  window.closeAlert = function closeAlert() {
    document.getElementById('alertModal').classList.add('hidden');
  };

  window.showConfirm = function showConfirm(title, message, callback, cancelCallback, confirmText, cancelText) {
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMsg').textContent = message;
    document.getElementById('confirmBtn').textContent = confirmText || t('services.remove');
    document.getElementById('confirmCancelBtn').textContent = cancelText || t('static.cancel');
    document.getElementById('confirmModal').classList.remove('hidden');
    confirmCallback = callback;
    confirmCancelCallback = cancelCallback;
  };

  window.closeConfirm = function closeConfirm() {
    document.getElementById('confirmModal').classList.add('hidden');
    document.getElementById('confirmBtn').textContent = t('static.delete');
    document.getElementById('confirmCancelBtn').textContent = t('static.cancel');
    confirmCallback = null;
    confirmCancelCallback = null;
  };

  window.doConfirm = function doConfirm() {
    const callback = confirmCallback;
    closeConfirm();
    if (callback) callback();
  };

  window.doCancelConfirm = function doCancelConfirm() {
    const callback = confirmCancelCallback;
    closeConfirm();
    if (callback) callback();
  };

  window.showChoiceModal = function showChoiceModal(title, desc, options, callback) {
    document.getElementById('choiceTitle').textContent = title;
    document.getElementById('choiceDesc').textContent = desc || '';
    document.getElementById('choiceCancelBtn').textContent = t('static.cancel');

    const container = document.getElementById('choiceOptions');
    container.innerHTML = '';

    for (const option of options || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'choice-option';
      button.disabled = !!option.disabled;

      if (option.icon) {
        const icon = document.createElement('img');
        icon.className = 'choice-option-icon';
        icon.src = option.icon;
        icon.alt = option.label;
        icon.onerror = () => {
          icon.style.display = 'none';
        };
        button.appendChild(icon);
      }

      const content = document.createElement('span');
      content.className = 'choice-option-content';

      const titleNode = document.createElement('span');
      titleNode.className = 'choice-option-title';
      titleNode.textContent = option.label;
      content.appendChild(titleNode);

      if (option.description) {
        const descNode = document.createElement('span');
        descNode.className = 'choice-option-desc';
        descNode.textContent = option.description;
        content.appendChild(descNode);
      }

      button.appendChild(content);

      button.addEventListener('click', () => {
        const selected = option.value;
        const handler = choiceCallback;
        closeChoiceModal();
        if (handler) handler(selected);
      });

      container.appendChild(button);
    }

    choiceCallback = callback;
    document.getElementById('choiceModal').classList.remove('hidden');
    const firstEnabled = container.querySelector('button:not(:disabled)');
    if (firstEnabled) firstEnabled.focus();
  };

  window.closeChoiceModal = function closeChoiceModal() {
    document.getElementById('choiceModal').classList.add('hidden');
    document.getElementById('choiceOptions').innerHTML = '';
    choiceCallback = null;
  };

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      if (!document.getElementById('inputModal').classList.contains('hidden')) submitModal();
      else if (!document.getElementById('alertModal').classList.contains('hidden')) closeAlert();
      else if (!document.getElementById('confirmModal').classList.contains('hidden')) doConfirm();
    }
    if (event.key === 'Escape') {
      closeModal();
      closeAlert();
      closeConfirm();
      closeChoiceModal();
    }
  });
})();
