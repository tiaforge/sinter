// A real ASP.NET Core SignalR hub for the transport e2e test. The Node server (../server.mjs)
// proxies /hubs/* here, so the page talks to it same-origin, as behind a reverse proxy.
// /control/* is for the test runner only: broadcast an event, abort every connection, count them.
using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Services.AddSignalR();
var app = builder.Build();

app.MapHub<PeopleHub>("/hubs/people");
app.MapPost("/control/emit", async (Emit e, IHubContext<PeopleHub> hub) =>
{
    await hub.Clients.All.SendAsync(e.Event, e.Data);
    return Results.Ok();
});
app.MapPost("/control/drop", () =>
{
    foreach (var c in PeopleHub.Connections.Values) c.Abort();
    return Results.Ok();
});
app.MapGet("/control/stats", () => new { connected = PeopleHub.Connections.Count, total = PeopleHub.Total });
app.Run();

record Emit(string Event, JsonElement Data);

class PeopleHub : Hub
{
    public static readonly ConcurrentDictionary<string, HubCallerContext> Connections = new();
    public static int Total;

    public override Task OnConnectedAsync()
    {
        Connections[Context.ConnectionId] = Context;
        Interlocked.Increment(ref Total);
        return base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        Connections.TryRemove(Context.ConnectionId, out _);
        return base.OnDisconnectedAsync(exception);
    }
}
