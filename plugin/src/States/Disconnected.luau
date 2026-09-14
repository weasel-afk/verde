local SharedFolder = require(script.Parent.Parent.Shared)
local ButtonInstance = SharedFolder.ButtonInstance
local Icons = SharedFolder.Icons
local State = SharedFolder.State

local disconnected = State.new()

disconnected.onEnter = function(transitionTo: (string) -> (), ...)
	if ButtonInstance.button then
		ButtonInstance.button.Icon = Icons.DISCONNECTED
	end
end

disconnected.onExit = function() end
disconnected.onUpdate = function(dt) end

return disconnected
