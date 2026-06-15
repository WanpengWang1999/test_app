import React, { useCallback, useState } from 'react';

export function useConfirmDialog() {
  const [options, setOptions] = useState(null);

  const confirm = useCallback((nextOptions) => new Promise((resolve) => {
    setOptions({
      title: '确认操作',
      message: '',
      confirmText: '确认',
      cancelText: '取消',
      danger: false,
      details: [],
      ...nextOptions,
      resolve
    });
  }), []);

  const dialog = options ? (
    <ConfirmDialog
      options={options}
      onCancel={() => {
        options.resolve(false);
        setOptions(null);
      }}
      onConfirm={() => {
        options.resolve(true);
        setOptions(null);
      }}
    />
  ) : null;

  return { confirm, dialog };
}

function ConfirmDialog({ options, onCancel, onConfirm }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="confirm-modal">
        <h3>{options.title}</h3>
        {options.message && <p>{options.message}</p>}
        {options.details?.length > 0 && (
          <ul className="confirm-details">
            {options.details.map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
        <div className="inline-actions">
          <button type="button" className="ghost" onClick={onCancel}>{options.cancelText}</button>
          <button type="button" className={options.danger ? 'danger-action' : ''} onClick={onConfirm}>{options.confirmText}</button>
        </div>
      </div>
    </div>
  );
}
