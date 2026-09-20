import { useEffect, useRef, useState } from 'react';
import { postFeedback, type FeedbackBody, type FeedbackContext, type FeedbackStrings } from './api';

export default function FeedbackModal({ strings: S, context, onClose }: {
  strings: FeedbackStrings; context: FeedbackContext | null; onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const [rating, setRating] = useState(0);
  const [wellLit, setWellLit] = useState<FeedbackBody['well_lit']>('somewhat');
  const [escort, setEscort] = useState<NonNullable<FeedbackBody['escort_helpful']>>('neutral');
  const [comment, setComment] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current!;
    root.focus();
    const focusInside = (event: FocusEvent) => {
      if (!root.contains(event.target as Node)) root.focus();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const checkedRadio = root.querySelector<HTMLInputElement>('input[type="radio"]:checked');
      const firstRadio = root.querySelector<HTMLInputElement>('input[type="radio"]');
      const items = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)'))
        .filter(item => !(item instanceof HTMLInputElement) || item.type !== 'radio' || item === (checkedRadio || firstRadio));
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); root.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard, true);
    document.addEventListener('focusin', focusInside);
    return () => {
      request.current?.abort();
      document.removeEventListener('keydown', keyboard, true);
      document.removeEventListener('focusin', focusInside);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);
  useEffect(() => {
    if (state !== 'success') return;
    dialog.current?.focus();
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [state, onClose]);
  const send = async () => {
    if (!rating || !context || request.current || state === 'success') return;
    const controller = new AbortController();
    request.current = controller;
    setState('sending');
    try {
      await postFeedback({ ...context, rating, well_lit: wellLit, comment,
        ...(context.escort_triggered ? { escort_helpful: escort } : {}) }, controller.signal);
      if (!controller.signal.aborted) setState('success');
    } catch { if (!controller.signal.aborted) setState('error'); }
    finally { if (request.current === controller) request.current = null; }
  };
  const choiceStyle = (active: boolean) => ({ background: active ? 'rgba(26,115,232,0.2)' : 'rgba(255,255,255,0.05)', border: `1px solid ${active ? '#1a73e8' : 'rgba(255,255,255,0.1)'}` });
  return <div className="fixed inset-0 z-[250] flex items-center justify-center p-4" style={{ background: 'rgba(8,10,18,0.92)', backdropFilter: 'blur(6px)' }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="feedback-title" tabIndex={-1}
      className="relative w-full max-w-md overflow-y-auto text-white outline-none"
      style={{ background: '#13151f', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '20px', boxShadow: '0 32px 80px rgba(0,0,0,0.7)', maxHeight: '90dvh' }}>
      <div className="px-6 pt-6 pb-5 text-center" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
        <h2 id="feedback-title" className="text-xl font-bold">{S.title}</h2>
      </div>
      {state === 'success' ? <p role="status" className="p-6 text-sm text-center">{S.success}</p> :
        <form className="p-6 space-y-5" aria-busy={state === 'sending'} onSubmit={event => { event.preventDefault(); void send(); }}>
          <fieldset disabled={state === 'sending'}>
            <legend className="text-sm mb-2">{S.rating_label}</legend>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(value => <label key={value} className="relative flex-1 cursor-pointer">
                <input className="peer sr-only" type="radio" name="feedback-rating" value={value} required checked={rating === value}
                  aria-label={`${S.rating_label} ${value} / 5`} onChange={() => setRating(value)} />
                <span className="flex min-h-11 items-center justify-center rounded-xl text-2xl peer-focus-visible:outline-2 peer-focus-visible:outline-white"
                  style={{ ...choiceStyle(rating === value), color: value <= rating ? '#fbbf24' : 'rgba(255,255,255,0.35)' }} aria-hidden="true">★</span>
              </label>)}
            </div>
          </fieldset>
          <fieldset disabled={state === 'sending'}>
            <legend className="text-sm mb-2">{S.well_lit_question}</legend>
            <div className="flex gap-2">{(Object.keys(S.well_lit_options) as FeedbackBody['well_lit'][]).map(value =>
              <button key={value} type="button" aria-pressed={wellLit === value} onClick={() => setWellLit(value)} className="flex-1 min-w-0 min-h-11 rounded-xl px-2 text-sm" style={choiceStyle(wellLit === value)}>{S.well_lit_options[value]}</button>)}</div>
          </fieldset>
          {context?.escort_triggered && <fieldset disabled={state === 'sending'}>
            <legend className="text-sm mb-2">{S.escort_question}</legend>
            <div className="flex gap-2">{(Object.keys(S.escort_options) as NonNullable<FeedbackBody['escort_helpful']>[]).map(value =>
              <button key={value} type="button" aria-pressed={escort === value} onClick={() => setEscort(value)} className="flex-1 min-w-0 min-h-11 rounded-xl px-2 text-sm" style={choiceStyle(escort === value)}>{S.escort_options[value]}</button>)}</div>
          </fieldset>}
          <div>
            <label htmlFor="feedback-comment" className="block text-sm mb-2">{S.comment_label}</label>
            <textarea id="feedback-comment" value={comment} onChange={event => setComment(event.target.value)} maxLength={500} rows={3} disabled={state === 'sending'}
              aria-describedby="feedback-hint feedback-count" className="w-full rounded-xl p-3 text-sm resize-y" style={choiceStyle(false)} />
            <div className="flex justify-between gap-3 mt-1 text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
              <span id="feedback-hint">{S.comment_hint}</span><span id="feedback-count" aria-live="polite" className="shrink-0 tabular-nums">{comment.length}/500</span>
            </div>
          </div>
          {state === 'error' && <p role="alert" className="text-sm text-red-400">{S.error}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="rounded-xl px-4 py-3 text-sm" style={choiceStyle(false)}>{S.skip}</button>
            <button type="submit" disabled={!rating || !context || state === 'sending'} className="flex-1 flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold disabled:opacity-40" style={{ background: '#1a73e8' }}>
              {state === 'sending' && <span aria-hidden="true" className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin motion-reduce:animate-none" />}{S.submit}
            </button>
          </div>
        </form>}
    </div>
  </div>;
}
