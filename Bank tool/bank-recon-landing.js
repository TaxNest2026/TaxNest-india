// bank-recon-landing.js
// Depends on BANK_LIST from bank-list.js (loaded first in the HTML).
// No network calls. This page only captures bank + file selection —
// extraction/review is a separate, not-yet-built step (see continue-note).

(function () {
  var input = document.getElementById('bank-input');
  var toggleBtn = document.getElementById('bank-toggle');
  var listEl = document.getElementById('bank-listbox');
  var combobox = document.getElementById('bank-combobox');

  var dropzone = document.getElementById('dropzone');
  var fileInput = document.getElementById('file-input');
  var chooseBtn = document.getElementById('choose-file-btn');
  var emptyState = document.getElementById('dropzone-empty');
  var fileState = document.getElementById('dropzone-file');
  var fileNameEl = document.getElementById('file-name');
  var fileSizeEl = document.getElementById('file-size');
  var removeBtn = document.getElementById('file-remove');
  var fileHint = document.getElementById('file-hint');

  var continueBtn = document.getElementById('continue-btn');
  var continueNote = document.getElementById('continue-note');

  var selectedBank = null;
  var selectedFile = null;
  var activeIndex = -1;

  var PRIORITY_BANKS = BANK_LIST.filter(function (b) { return b.priority; });
  var NON_PRIORITY_COUNT = BANK_LIST.length - PRIORITY_BANKS.length;

  function normalize(str) {
    return str.toLowerCase();
  }

  function appendGroup(label, items) {
    if (!items.length) return;
    if (label) {
      var header = document.createElement('li');
      header.className = 'group-label';
      header.textContent = label;
      listEl.appendChild(header);
    }
    items.forEach(function (b) {
      var li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.id = b.id;
      li.dataset.name = b.name;

      var nameSpan = document.createElement('span');
      nameSpan.textContent = b.name;

      var idSpan = document.createElement('span');
      idSpan.className = 'bank-id';
      idSpan.textContent = b.id;

      li.appendChild(nameSpan);
      li.appendChild(idSpan);
      li.addEventListener('click', function () { selectBank(b); });
      listEl.appendChild(li);
    });
  }

  function appendEmptyRow(text) {
    var li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    listEl.appendChild(li);
  }

  function renderList(query) {
    var q = normalize(query.trim());
    listEl.innerHTML = '';
    activeIndex = -1;

    if (!q) {
      appendGroup('Common banks', PRIORITY_BANKS);
      appendEmptyRow('Type to search the remaining ' + NON_PRIORITY_COUNT + ' banks, including cooperative and regional banks.');
      return;
    }

    var matches = BANK_LIST.filter(function (b) {
      return normalize(b.name).indexOf(q) !== -1;
    });

    if (matches.length === 0) {
      appendEmptyRow('No banks match "' + query + '". Try "Other Bank" or a different spelling.');
      return;
    }

    var priorityMatches = matches.filter(function (b) { return b.priority; });
    var restMatches = matches.filter(function (b) { return !b.priority && b.name !== 'Other Bank'; });
    var otherEntry = matches.filter(function (b) { return b.name === 'Other Bank'; });

    appendGroup(priorityMatches.length ? 'Common banks' : '', priorityMatches);
    appendGroup(priorityMatches.length && restMatches.length ? 'All banks' : '', restMatches);
    appendGroup('', otherEntry);
  }

  function openList() {
    listEl.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closeList() {
    listEl.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  }

  function selectBank(bank) {
    selectedBank = bank;
    input.value = bank.name;
    closeList();
    checkReady();
  }

  input.addEventListener('input', function () {
    selectedBank = null;
    renderList(input.value);
    openList();
    checkReady();
  });

  input.addEventListener('focus', function () {
    renderList(input.value);
    openList();
  });

  toggleBtn.addEventListener('click', function () {
    if (listEl.hidden) {
      renderList(input.value);
      openList();
      input.focus();
    } else {
      closeList();
    }
  });

  document.addEventListener('click', function (e) {
    if (!combobox.contains(e.target)) closeList();
  });

  input.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(listEl.querySelectorAll('li[role="option"]'));
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, items.length - 1);
      items.forEach(function (i) { i.classList.remove('active'); });
      items[activeIndex].classList.add('active');
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      items.forEach(function (i) { i.classList.remove('active'); });
      items[activeIndex].classList.add('active');
      items[activeIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        selectBank({ id: items[activeIndex].dataset.id, name: items[activeIndex].dataset.name });
      }
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  // ---- File upload ----

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function handleFile(file) {
    if (!file) return;
    if (file.type !== 'application/pdf') {
      fileHint.hidden = false;
      fileHint.textContent = '"' + file.name + '" is not a PDF. Please upload the statement as a PDF file.';
      return;
    }
    fileHint.hidden = true;
    selectedFile = file;
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatSize(file.size);
    emptyState.hidden = true;
    fileState.hidden = false;
    checkReady();
  }

  chooseBtn.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function (e) { handleFile(e.target.files[0]); });

  dropzone.addEventListener('dragover', function (e) {
    e.preventDefault();
    dropzone.classList.add('drag-active');
  });
  dropzone.addEventListener('dragleave', function () {
    dropzone.classList.remove('drag-active');
  });
  dropzone.addEventListener('drop', function (e) {
    e.preventDefault();
    dropzone.classList.remove('drag-active');
    var file = e.dataTransfer.files[0];
    handleFile(file);
  });

  removeBtn.addEventListener('click', function () {
    selectedFile = null;
    fileInput.value = '';
    emptyState.hidden = false;
    fileState.hidden = true;
    continueNote.hidden = true;
    checkReady();
  });

  function checkReady() {
    continueBtn.disabled = !(selectedBank && selectedFile);
  }

  continueBtn.addEventListener('click', function () {
    continueNote.hidden = false;
    continueNote.textContent = 'Captured: ' + selectedBank.name + ' (ID ' + selectedBank.id + ') — ' +
      selectedFile.name + '. Extraction and ledger review aren\'t built yet — this step only records the bank and file for now.';
  });

  renderList('');
})();
