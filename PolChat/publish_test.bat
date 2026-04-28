dotnet publish PolChat.csproj -o bin\publish -c Release -r win-x64   --self-contained true   -p:PublishAot=true      -p:PublishSingleFile=true   -p:IncludeNativeLibrariesForSelfExtract=true   -p:DebugType=None   -p:DebugSymbols=false   -p:IlcInvariantGlobalization=true   -p:UseCurrentRuntimeIdentifier=true

pause 10