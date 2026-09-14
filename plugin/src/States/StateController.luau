local RunService = game:GetService("RunService")

local StateModule = require(script.Parent.Parent.Shared.State)
local States = require(script.Parent)

type State = StateModule.State

local _currentState: State? = nil

local StateController = {}

local _transitionTo: (stateName: string) -> ()

function StateController.SwitchState(stateName: string)
	assert(States[stateName], "State not found")

	local retValue = nil

	if _currentState then
		retValue = _currentState.onExit()
	end

	local state = States[stateName]
	_currentState = state
	state.onEnter(_transitionTo, retValue)
end

function _transitionTo(stateName: string)
	StateController.SwitchState(stateName)
end

function StateController.GetState(): string?
	local stateName = nil

	for name, state in States do
		if state == _currentState then
			stateName = name
			break
		end
	end

	return stateName
end

local _heartbeatConnection: RBXScriptConnection? = RunService.Heartbeat:Connect(function(dt)
	if RunService:IsRunning() then
		return
	end

	if not _currentState then
		return
	end

	_currentState.onUpdate(dt, _transitionTo)
end)

function StateController.Cleanup()
	if _heartbeatConnection then
		_heartbeatConnection:Disconnect()
		_heartbeatConnection = nil
	end
end

return StateController
