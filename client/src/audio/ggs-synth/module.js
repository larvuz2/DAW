// The one place that knows where the worklet file lives. Vite bundles worklet.js (with the DSP package inside) as
// its own file and hands back the URL; it is same-origin, which the studio's CSP (script-src 'self') requires.
import workletUrl from './worklet.js?worker&url';

export { workletUrl };
