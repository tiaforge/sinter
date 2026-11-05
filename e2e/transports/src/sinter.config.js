// /ws/… streams use the WebSocket transport, /hubs/… the SignalR recipe's adapter (imported from
// docs/recipes, so the recipe itself is what runs), anything else EventSource.
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { configure } from '@tiaforge/sinter';
import { webSocketTransport } from '@tiaforge/sinter/ws';
import { signalRTransport } from '../../../docs/recipes/signalr-transport.js';

configure({
  sessionProbe: '/api/user',
  transport: (url) => {
    if (url.startsWith('/ws/')) return webSocketTransport();
    if (url.startsWith('/hubs/')) return signalRTransport(() => new HubConnectionBuilder().withUrl(url).configureLogging(LogLevel.Warning).build());
    return undefined;
  },
});
