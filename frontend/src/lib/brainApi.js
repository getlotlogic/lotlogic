// The HQ tab's three calls. Everything goes through apiFetch so the session JWT,
// the 401 -> auth-expired path and the Pydantic-422 message handling are the
// same as every other page.
import { apiFetch } from './api.js';

export function fetchBoard() {
  return apiFetch('/brain/board');
}

export function answerQuestion(id, answer) {
  return apiFetch(`/brain/questions/${id}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer }),
  });
}

export function closeFinding(id, reason) {
  return apiFetch(`/brain/findings/${id}/close`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}
