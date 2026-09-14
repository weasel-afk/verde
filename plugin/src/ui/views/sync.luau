local config = require(script.Parent.Parent.Parent.config)
local store = require(script.Parent.Parent.Parent.store)
local sync = require(script.Parent.Parent.Parent.sync)
local vide = require(script.Parent.Parent.Parent.packages.vide)

local create = vide.create

local button = require(script.Parent.Parent.components.button)
local input = require(script.Parent.Parent.components.input)

-- Status colors for the connection label.
local STATUS_COLORS = {
    Connected = Color3.fromRGB(120, 210, 100),
    Error = Color3.fromRGB(240, 90, 90),
}

return function()
    local activeView: vide.Source<string?> = store.get("ActiveView")
    local title: vide.Source<string?> = store.get("Title")
    title("Verde")

    local port: vide.Source<string> = store.get("Port", "34872")
    local status: vide.Source<string> = store.get("ConnectionStatus", "Offline")

    return create("Frame") {
        BackgroundTransparency = 1,
        Size = UDim2.fromScale(1, 1),

        create("UIListLayout") {
            HorizontalAlignment = Enum.HorizontalAlignment.Center,
        },

        -- Port input
        input {
            Text = port,
            PlaceholderText = "Port",
            ClearTextOnFocus = false,
            FocusLost = function()
                local value = tonumber(port())
                if value then
                    config.updateSetting("Port", tostring(math.floor(value)))
                else
                    -- Reset the field to the current setting on invalid input.
                    port(config.getSetting("Port"))
                end
            end,
        },

        -- Connect button
        button {
            Text = "Connect",
            Activated = function()
                if store.getValue("ConnectionStatus", "Offline") == "Connected" then
                    sync.disconnect()
                else
                    sync.connect()
                end
            end,
        },

        -- Connection status
        create("TextLabel") {
            Size = UDim2.fromScale(1, 0.15),
            BackgroundTransparency = 1,
            TextSize = 13,
            Font = Enum.Font.Code,
            Text = status,
            TextColor3 = STATUS_COLORS[status()] or Color3.fromRGB(160, 160, 160),
        },

        -- Settings view
        button {
            Text = "Settings",
            Activated = function()
                activeView("settings")
            end,
        },
    }
end
