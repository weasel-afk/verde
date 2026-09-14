--[[
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
]]

if not plugin then
    return error("Please run Verde in a plugin context")
end

-- The plugin is distributed as a single script whose children are the
-- source tree (the rojo init.server.luau convention), so modules resolve
-- from the script itself rather than a parent folder.
local store = require(script.store)
local vide = require(script.packages.vide)
vide.strict = true -- Enable strict mode

-- Setup Plugin Widget
local widgetSettings = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, true, false, 320, 210, 300, 210)
local verdeWidget = plugin:CreateDockWidgetPluginGui("VerdeWidget", widgetSettings)
verdeWidget.Title = "Verde"

-- Setup plugin toolbar
local verdeToolbar = plugin:CreateToolbar("Verde")
local uiToggleBtn = verdeToolbar:CreateButton("Verde", "Toggle Verde UI", "rbxassetid://14891988900")
uiToggleBtn:SetActive(verdeWidget.Enabled)
store.set("UIShown", verdeWidget.Enabled)

local unmountApp
uiToggleBtn.Click:Connect(function()
    store.set("UIShown", verdeWidget.Enabled)
    verdeWidget.Enabled = not verdeWidget.Enabled

    -- Initialise UI
    if verdeWidget.Enabled then
        unmountApp = vide.mount(require(script.ui.app), verdeWidget)
    elseif unmountApp then
        unmountApp()
    end
end)

-- Initialise Toasts
-- Toasts are persistent so do not need to be unmounted.
vide.mount(require(script.ui.toasts), game.CoreGui)
