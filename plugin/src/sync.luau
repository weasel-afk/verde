--[[
    Sync

    Controls the sync session lifecycle: connecting to the Verde cli,
    exporting the game tree, polling the heartbeat and applying actions.
]]
local Session = require(script.Parent.session)
local config = require(script.Parent.config)
local decoder = require(script.Parent.tree.decoder)
local encoder = require(script.Parent.tree.encoder)
local store = require(script.Parent.store)

-- The number of consecutive heartbeat failures before backing off.
local FAILURE_LIMIT = 10

local Sync = {}

local current: any? = nil

--[[
    Connects to the Verde cli session and starts syncing.
]]
function Sync.connect()
    if current then
        return
    end

    local defaults = config.getConfig()
    local host = config.getSetting("Host") :: string
    local port = tonumber(config.getSetting("Port")) or defaults.PORT

    local session = Session.new(host, port)
    local ok, err = session:connect(store.getValue("VERSION"))
    if not ok then
        store.set("ConnectionStatus", "Error")
        warn(`Verde failed to connect: {err}`)
        store.add("Toasts", {
            Message = `Failed to connect: {err}`,
            Severity = "Error",
            Time = os.time(),
            Lifetime = 5,
        })
        return
    end

    current = session
    store.set("ConnectionStatus", "Connected")

    -- Export the game tree, then keep applying heartbeats until disconnect.
    local interval = defaults.HEARTBEAT_INTERVAL
    task.spawn(function()
        local requestOk, response, requestErr = pcall(function()
            return session:postTree(encoder.export(session.Services))
        end)
        local exported = requestOk and response ~= nil
        local err = if requestOk then requestErr else response
        if not exported then
            warn(`Verde failed to export the game tree: {err}`)
        end

        local failures = 0
        while session.Connected do
            local payload = session:fetchHeartbeat()
            if payload then
                failures = 0
                store.set("ConnectionStatus", "Connected")
                if payload.events and #payload.events > 0 then
                    local result = decoder.apply(payload.events)
                    if #result.failed > 0 then
                        warn(`Verde failed to apply {#result.failed} actions:\n{table.concat(result.failed, "\n")}`)
                    end
                end
                if payload.cursor ~= nil then
                    local _, ackErr = session:ackHeartbeat(payload.cursor)
                    if ackErr then
                        warn(`Verde failed to acknowledge heartbeat: {ackErr}`)
                    end
                end
            else
                failures += 1
                if failures == FAILURE_LIMIT then
                    store.set("ConnectionStatus", "Error")
                    warn("Verde heartbeat is failing; retrying slowly")
                end
            end

            task.wait(if failures >= FAILURE_LIMIT then 2 else interval)
        end
    end)
end

--[[
    Disconnects from the current session.
]]
function Sync.disconnect()
    if not current then
        return
    end

    current:disconnect()
    current = nil
    store.set("ConnectionStatus", "Offline")
end

return Sync
