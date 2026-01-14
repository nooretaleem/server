

// DOM Elements
const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('toggleBtn');
const mobileMenuBtn = document.getElementById('mobileMenuBtn');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const navLinks = document.querySelectorAll('.nav-link');

// Function to open sidebar on mobile
function openMobileSidebar() {
    sidebar.classList.add('show');
    sidebarBackdrop.style.display = 'block';
    document.body.classList.add('overlay-active');
}

// Function to close sidebar on mobile
function closeMobileSidebar() {
    sidebar.classList.remove('show');
    sidebarBackdrop.style.display = 'none';
    document.body.classList.remove('overlay-active');
}

// Toggle sidebar collapse/expand (desktop only)
toggleBtn.addEventListener('click', function () {
    if (window.innerWidth > 768) {
        sidebar.classList.toggle('collapsed');
    }
});

// Mobile menu toggle
mobileMenuBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!sidebar.classList.contains('show')) {
        openMobileSidebar();
    } else {
        closeMobileSidebar();
    }
});

// Close sidebar when clicking backdrop
sidebarBackdrop.addEventListener('click', function () {
    closeMobileSidebar();
});

// Close sidebar when clicking outside on mobile
document.addEventListener('click', function (e) {
    if (
        window.innerWidth <= 768 &&
        !sidebar.contains(e.target) &&
        !mobileMenuBtn.contains(e.target)
    ) {
        closeMobileSidebar();
    }
});

// Active link switching
navLinks.forEach((link) => {
    link.addEventListener('click', function (e) {
        e.preventDefault();
        navLinks.forEach((l) => l.classList.remove('active'));
        this.classList.add('active');

        // Auto-close sidebar on mobile after selection
        if (window.innerWidth <= 768) {
            closeMobileSidebar();
        }
    });
});

// Handle window resize
window.addEventListener('resize', function () {
    if (window.innerWidth > 768) {
        closeMobileSidebar();
        sidebar.style.transform = '';
    } else {
        if (!sidebar.classList.contains('show')) {
            sidebar.style.transform = 'translateX(-100%)';
        }
        sidebar.classList.remove('collapsed');
    }
});

// Initialize sidebar state based on screen size
if (window.innerWidth <= 768) {
    sidebar.style.transform = 'translateX(-100%)';
}