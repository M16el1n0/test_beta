@echo off
set DL=%USERPROFILE%\Downloads
set REPO=%USERPROFILE%\Downloads

:loop
    set CHANGED=0
    
    for %%f in (fleep_bot.py script.js index.html style.css) do (
        if exist "%DL%\%%f.crdownload" (
            timeout /t 2 /nobreak >nul
        )
    )
    
    for %%f in (fleep_bot.py script.js index.html style.css) do (
        if exist "%DL%\%%f" (
            if not exist "%REPO%\%%f" (
                copy /Y "%DL%\%%f" "%REPO%\%%f" >nul
                set CHANGED=1
                echo Подхватил: %%f
            ) else (
                fc /b "%DL%\%%f" "%REPO%\%%f" >nul 2>&1
                if errorlevel 1 (
                    copy /Y "%DL%\%%f" "%REPO%\%%f" >nul
                    set CHANGED=1
                    echo Подхватил: %%f
                ) else (
                    del "%DL%\%%f"
                )
            )
        )
    )
    
    if %CHANGED%==1 (
        cd /d %REPO%
        git add .
        git commit -m "Auto update from Claude"
        git push
        echo.
        echo Запушено!
        echo.
    )
    
    timeout /t 5 /nobreak >nul
goto loop