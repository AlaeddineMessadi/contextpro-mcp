"use client";

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function readTheme(): Theme {
    const stored = localStorage.getItem("theme");
    return stored === "light" || stored === "dark" ? stored
        : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribeTheme(onChange: () => void) {
    window.addEventListener("storage", onChange);
    window.addEventListener("theme-change", onChange);
    return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener("theme-change", onChange);
    };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "light" as Theme);
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", theme);
    }, [theme]);

    const toggleTheme = () => {
        localStorage.setItem("theme", theme === "light" ? "dark" : "light");
        window.dispatchEvent(new Event("theme-change"));
    };

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        return { theme: "light" as Theme, toggleTheme: () => { } };
    }
    return context;
}
