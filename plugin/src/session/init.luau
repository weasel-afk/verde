--[[
	Session

	Manages the communuication between the Verde plugin and Verde cli.
]]
local HttpService = game:GetService("HttpService")

export type SessionData = {
    BaseUrl: string,
    Connected: boolean,
    Services: { string },
}

local Session = {}
Session.__index = Session

--[[
    Creates a new session.
]]
function Session.new(_host: string?, _port: number?, _secure: boolean?)
    local sessionData = {
        BaseUrl = `{if _secure then "https" else "http"}://{_host}:{_port}`,
        Connected = false,
        Services = {},
    }

    return setmetatable(sessionData, Session)
end

--[[
    Makes a HTTP request to the session, JSON encoding the body when
    provided and JSON decoding the response. Returns the decoded body
    (or nil) and an error message on failure.
]]
function Session:makeRequest(_path: string, _method: "GET" | "POST"?, _body: unknown?)
    local options = {
        Url = `{self.BaseUrl}/{_path}`,
        Method = _method or "GET",
    }

    if _body ~= nil then
        options.Headers = { ["Content-Type"] = "application/json" }
    end

    -- Encoding can fail on non-representable values; keep it inside the
    -- pcall so a bad body surfaces as a request error instead of throwing.
    local ok, result = pcall(function()
        if _body ~= nil then
            options.Body = HttpService:JSONEncode(_body)
        end

        return HttpService:RequestAsync(options)
    end)
    if not ok then
        return nil, result
    end
    if not result.Success then
        return nil, `{result.StatusCode} {result.StatusMessage}`
    end

    if result.Body ~= nil and result.Body ~= "" then
        local decodedOk, decodedBody = pcall(HttpService.JSONDecode, HttpService, result.Body)
        if decodedOk then
            return decodedBody, nil
        end
    end

    return nil, nil
end

--[[
    Connects to a session, storing the returned project configuration.
]]
function Session:connect(_pluginVersion: string?)
    local data, err = self:makeRequest("connect", "POST", {
        pluginVersion = _pluginVersion,
    })
    if not data then
        return false, err
    end

    self.Connected = true
    self.Services = data.services or {}

    return true, data
end

--[[
    Disconnects from the current session.
]]
function Session:disconnect()
    if not self.Connected then
        return
    end

    self.Connected = false
    self:makeRequest("disconnect", "POST")
end

--[[
    Fetches the current heartbeat payload, containing the ordered tree
    actions to apply.
]]
function Session:fetchHeartbeat()
    return self:makeRequest("heartbeat")
end

--[[
    Acknowledges all heartbeat actions through the supplied delivery cursor.
]]
function Session:ackHeartbeat(cursor: number)
    return self:makeRequest("heartbeat", "POST", { cursor = cursor })
end

--[[
    Posts a game tree export to the session.
]]
function Session:postTree(tree: unknown)
    return self:makeRequest("tree", "POST", tree)
end

return Session
